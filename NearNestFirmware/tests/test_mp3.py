"""Build the actual on-device MP3 encoder and validate with FFmpeg/ffprobe."""
from pathlib import Path
import json, math, os, random, struct, subprocess, tempfile
root = Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory() as directory:
    tmp = Path(directory)
    objects = []
    for source in sorted((root / 'src/shine').glob('*.c')):
        obj = tmp / (source.stem + '.o')
        subprocess.run([os.environ.get('CC', 'cc'), '-O2', '-c', str(source), '-o', str(obj)], check=True)
        objects.append(str(obj))
    exe = tmp / 'encode'
    subprocess.run([os.environ.get('CXX', 'c++'), '-std=c++11', '-O2', str(root/'tests/mp3_encode.cpp'), *objects, '-o', str(exe)], check=True)
    rng = random.Random(42)
    cases = {
        'empty': [],
        'short': [1, -1, 1000],
        'silence': [0] * 16000,
        'tone': [int(12000 * math.sin(i * 2 * math.pi * 440 / 16000)) for i in range(160003)],
        'noise': [rng.randint(-32768, 32767) for _ in range(16001)],
        'frame_boundary': [int(12000 * math.sin(i * 2 * math.pi * 440 / 16000)) for i in range(576 * 20)],
        'extremes': [-32768, 32767] * 8193,
    }
    for name, samples in cases.items():
        source = tmp / 'in.pcm'
        source.write_bytes(struct.pack('<' + 'h' * len(samples), *samples))
        reference = None
        for chunk in (512, 127):
            output = tmp / f'{name}-{chunk}.mp3'
            subprocess.run([str(exe), str(source), str(output), str(chunk)], check=True)
            data = output.read_bytes()
            if reference is not None:
                assert data == reference, (name, 'chunk boundaries changed output')
            reference = data
        if not samples:
            assert not data
            continue
        probe = json.loads(subprocess.check_output(['ffprobe', '-v', 'error', '-show_streams', '-of', 'json', str(output)]))['streams'][0]
        assert probe['codec_name'] == 'mp3' and probe['sample_rate'] == '16000' and probe['channels'] == 1, probe
        assert probe['bit_rate'] == '64000', probe
        pcm = subprocess.check_output(['ffmpeg', '-v', 'error', '-xerror', '-i', str(output), '-f', 's16le', '-'])
        decoded = struct.unpack('<' + 'h' * (len(pcm) // 2), pcm)
        assert len(samples) <= len(decoded) <= len(samples) + 1728, (name, len(samples), len(decoded))
        if name in ('tone', 'frame_boundary'):
            # Confirm frequency, amplitude, and audible tail after encoder delay.
            delay = max(range(1400), key=lambda lag: sum(samples[i] * decoded[i+lag] for i in range(min(3000,len(samples)))))
            window = min(8000, len(samples))
            signal = sum(x*x for x in samples[-window:])
            error = sum((samples[i] - decoded[i+delay])**2 for i in range(len(samples)-window,len(samples)))
            snr = 10 * math.log10(signal / max(error, 1))
            assert snr > 15, (name, 'poor tone fidelity/tail', snr, delay)
        print(f'{name}: PCM={len(samples)*2} MP3={len(data)}; 16 kHz mono 64 kbps, decode OK')
