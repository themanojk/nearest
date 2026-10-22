#pragma once
#include <stdint.h>
#include <stddef.h>
#include <string.h>
// Bounded mono 16-bit FLAC encoder: fixed predictors 0/1/2, Rice coding,
// verbatim fallback, per-frame CRCs. No heap or external codec dependency.
namespace nest_flac {
constexpr size_t headerBytes = 42;
inline uint32_t fold(int32_t v) { return v < 0 ? uint32_t(-v) * 2 - 1 : uint32_t(v) * 2; }
inline uint16_t crc(const uint8_t* p, size_t n, unsigned bits, uint16_t poly) {
  uint16_t c = 0;
  while (n--) { c ^= uint16_t(*p++) << (bits - 8); for (int j=0;j<8;j++) c = (c & (1u << (bits-1))) ? (c << 1) ^ poly : c << 1; }
  return bits == 8 ? c & 255 : c;
}
struct Bits {
  uint8_t* p; size_t cap, bit = 0; bool ok = true;
  Bits(uint8_t* output, size_t capacity) : p(output), cap(capacity) {}
  void put(uint64_t v, unsigned n) {
    while(n--) { if(bit / 8 >= cap) { ok=false; return; } if(!(bit%8)) p[bit/8]=0; p[bit/8] |= ((v >> n)&1) << (7-bit%8); ++bit; }
  }
  void align() { if(bit%8) put(0,8-bit%8); }
};
inline void header(uint8_t* out, uint64_t samples) {
  memset(out,0,headerBytes); memcpy(out,"fLaC",4); out[4]=0x80; out[7]=34;
  out[9]=16; out[10]=2; // min block 16, max 512; final block may be shorter
  uint64_t info = (uint64_t(16000)<<44) | (uint64_t(15)<<36) | samples;
  for(int i=0;i<8;i++) out[18+i] = info >> (56-8*i);
  // All-zero MD5 denotes unavailable; CRC8/CRC16 protect each frame.
}
inline int32_t residual(const int16_t* pcm, size_t i, unsigned order) {
  return int32_t(pcm[i]) - (order == 2 ? 2*int32_t(pcm[i-1])-pcm[i-2] : order == 1 ? pcm[i-1] : 0);
}
inline size_t encode(const int16_t* pcm, size_t n, uint64_t sampleOffset, uint8_t* out, size_t cap) {
  if(!n || n>512 || cap< n*2+32) return 0;
  Bits b{out,cap}; b.put(0xfff9,16); b.put(0x75,8); b.put(0x08,8); // explicit 16 kHz, 16-bit mono
  unsigned bytes=1;
  if(sampleOffset>=128) { bytes=2; while(bytes<7 && sampleOffset >= (uint64_t(1) << (5*bytes+1))) ++bytes; }
  if(bytes==1) b.put(sampleOffset,8);
  else {
    b.put((0xff << (8-bytes)) | (sampleOffset >> (6*(bytes-1))),8);
    for(int i=bytes-2;i>=0;i--) b.put(0x80 | ((sampleOffset >> (6*i))&63),8);
  }
  b.put(n-1,16); b.put(crc(out,b.bit/8,8,7),8);
  uint64_t best=n*16; unsigned order=0,kbest=0; bool coded=false;
  for(unsigned o=0;o<=2 && o<n;o++) for(unsigned k=0;k<15;k++) {
    uint64_t cost=o*16+10;
    for(size_t i=o;i<n;i++) cost += (fold(residual(pcm,i,o))>>k)+1+k;
    if(cost<best) { best=cost; order=o; kbest=k; coded=true; }
  }
  b.put(coded ? (0x10 | (order<<1)) : 2,8);
  if(!coded) { for(size_t i=0;i<n;i++) b.put(uint16_t(pcm[i]),16); }
  else {
    for(unsigned i=0;i<order;i++) b.put(uint16_t(pcm[i]),16);
    b.put(0,6); b.put(kbest,4);
    for(size_t i=order;i<n;i++) {
      uint32_t v=fold(residual(pcm,i,order));
      for(uint32_t q=v>>kbest;q;q--) b.put(0,1);
      b.put(1,1); b.put(v,kbest);
    }
  }
  b.align(); uint16_t check=crc(out,b.bit/8,16,0x8005); b.put(check,16);
  return b.ok ? b.bit/8 : 0;
}
}
