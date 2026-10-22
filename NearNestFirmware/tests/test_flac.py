"""Host round-trip test against FFmpeg; requires c++ and ffmpeg in PATH."""
import pathlib, subprocess, tempfile, math, random, struct, wave
root = pathlib.Path(__file__).resolve().parent
with tempfile.TemporaryDirectory() as tmp:
    tmp = pathlib.Path(tmp)
    exe = tmp / 'encoder'
    subprocess.run(['c++', '-std=c++11', '-O2', str(root/'flac_encode.cpp'), '-o', str(exe)], check=True)
    rng = random.Random(42)
    cases = {
        'silence': [0]*16000,
        'tone': [int(12000*math.sin(i*2*math.pi*440/16000)) for i in range(160003)],
        'noise': [rng.randint(-32768,32767) for _ in range(16001)],
        'extremes': [-32768,32767]*8193,
        'short': [1,-1,32767],
    }
    for name, samples in cases.items():
        raw = struct.pack('<'+'h'*len(samples), *samples)
        source, encoded, decoded = tmp/'in.pcm', tmp/'out.flac', tmp/'decoded.pcm'
        source.write_bytes(raw)
        subprocess.run([str(exe), str(source), str(encoded)], check=True)
        subprocess.run(['ffmpeg','-v','error','-y','-i',str(encoded),'-f','s16le',str(decoded)],check=True)
        assert decoded.read_bytes()==raw, name
        playback = tmp/'playback.wav'
        subprocess.run(['ffmpeg','-v','error','-y','-i',str(encoded),'-c:a','pcm_s16le',str(playback)],check=True)
        with wave.open(str(playback)) as audio:
            assert audio.getframerate() == 16000, (name, 'incorrect playback sample rate')
            assert audio.getnchannels() == 1
            assert audio.readframes(audio.getnframes()) == raw, name
        print(f'{name}: PCM={len(raw)} FLAC={encoded.stat().st_size} ratio={encoded.stat().st_size/len(raw):.3f}; exact match')
