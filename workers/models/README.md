# Speaker embedding model

The worker expects this official sherpa-onnx/3D-Speaker model in this directory:

`3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx`

Download it from:

`https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx`

# Audio tagging model

The acoustic-event worker also expects:

- `audio-tagging/model.int8.onnx`
- `audio-tagging/class_labels_indices.csv`

They come from the official
`sherpa-onnx-zipformer-small-audio-tagging-2024-04-15` release:

`https://github.com/k2-fsa/sherpa-onnx/releases/download/audio-tagging-models/sherpa-onnx-zipformer-small-audio-tagging-2024-04-15.tar.bz2`
