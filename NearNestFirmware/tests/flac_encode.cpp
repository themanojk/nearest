#include "../lossless_flac.h"
#include <cstdio>
int main(int argc, char** argv) {
  if(argc!=3) return 1;
  FILE* in=fopen(argv[1],"rb"); FILE* out=fopen(argv[2],"wb+");
  if(!in || !out) return 2;
  uint8_t header[42], frame[1056]; int16_t pcm[512]; uint64_t samples=0;
  nest_flac::header(header,0); fwrite(header,1,42,out);
  size_t n;
  while((n=fread(pcm,2,512,in))) {
    size_t size=nest_flac::encode(pcm,n,samples,frame,sizeof(frame));
    if(!size) return 3;
    fwrite(frame,1,size,out); samples+=n;
  }
  nest_flac::header(header,samples); fseek(out,0,SEEK_SET); fwrite(header,1,42,out);
  fclose(in); fclose(out);
}
