# Put your own voice on your tracks (Google Colab)

Three Colab notebooks that take you from "I have a microphone" to "my voice is singing on my song".
They use [Applio](https://github.com/IAHispano/Applio) (an RVC voice-conversion engine) for training and conversion and
[Demucs](https://github.com/facebookresearch/demucs) to split vocals from instrumentals.

| # | Notebook | GPU? | What it does |
|---|----------|------|--------------|
| 1 | [`01_record_and_prepare_voice.ipynb`](01_record_and_prepare_voice.ipynb) | no | Record in the browser / upload takes, clean them, check quality, save a training dataset to Drive |
| 2 | [`02_train_voice_model.ipynb`](02_train_voice_model.ipynb) | **T4 or better** | Train your voice model; auto-backs-up to Drive so a disconnect doesn't lose progress; exports `.pth` + `.index` |
| 3 | [`03_add_my_voice_to_tracks.ipynb`](03_add_my_voice_to_tracks.ipynb) | **T4 or better** | Turns the vocal on a track into your voice and mixes it over the instrumental |

Open them in Colab (works once this folder is on the `main` branch of the repo):

[![01](https://img.shields.io/badge/Colab-01_record_&_prepare-F9AB00?logo=googlecolab)](https://colab.research.google.com/github/PlagueDrOnline/Edge-Browser-extension/blob/main/voice-cloning-colab/01_record_and_prepare_voice.ipynb)
[![02](https://img.shields.io/badge/Colab-02_train-F9AB00?logo=googlecolab)](https://colab.research.google.com/github/PlagueDrOnline/Edge-Browser-extension/blob/main/voice-cloning-colab/02_train_voice_model.ipynb)
[![03](https://img.shields.io/badge/Colab-03_add_to_tracks-F9AB00?logo=googlecolab)](https://colab.research.google.com/github/PlagueDrOnline/Edge-Browser-extension/blob/main/voice-cloning-colab/03_add_my_voice_to_tracks.ipynb)

Or in Colab: **File → Open notebook → GitHub tab**, paste the repo URL, pick a notebook. You can also upload the `.ipynb` files directly.

## How it fits together

Everything lives in one Drive folder, `MyDrive/MyVoice/`, so it survives Colab runtime resets:

```
MyVoice/
├── recordings/      raw takes of your voice          (notebook 1 input)
├── dataset/         cleaned 44.1 kHz mono WAVs        (notebook 1 output → notebook 2 input)
├── checkpoints/     training backups for resuming     (notebook 2, automatic)
├── models/<name>/   <name>.pth + <name>.index         (notebook 2 output → notebook 3 input)
├── tracks/          finished songs with a vocal       (notebook 3, "full_song" mode)
├── vocals/          guide vocals / acapellas          (notebook 3, "vocal_plus_instrumental" mode)
├── instrumentals/   matching instrumentals            (notebook 3, "vocal_plus_instrumental" mode)
└── output/<song>/   final mix + your vocal + instrumental
```

## Typical workflow

1. **Record 10-30 minutes** of your voice (talking *and* singing if you want to sing) in a quiet room, same mic every time.
   Run notebook 1.
2. **Train** with notebook 2 (about 30-90 min on a T4 for the default 300 epochs). Export when it finishes.
3. **Use it** with notebook 3:
   - You have a song with someone else's (or a placeholder) vocal → `full_song` mode.
   - You sang a rough guide vocal over your instrumental → `vocal_plus_instrumental` mode, with `CONVERT_VOCALS` on.
   - You sang the final vocal yourself and just want it mixed → same mode, `CONVERT_VOCALS` off.

Notebook 3 also saves your vocal and the instrumental as separate files so you can finish the mix in a DAW.

## Things worth knowing

- **Voice conversion changes the *timbre*, not the performance.** The melody, timing and words come from the source
  vocal. To get *your* performance, sing it yourself (guide vocal) and convert that.
- **Singing needs singing in the dataset.** A model trained only on speech struggles with sustained or high notes.
- The Applio version is pinned (`APPLIO_REF` in the install cell) so the notebooks keep working if Applio's CLI changes.
  Change it to `main` to try the newest.
- Demucs is installed in its own virtual environment (PyTorch 2.5.1) so it doesn't conflict with Applio's newer PyTorch.
- If the Colab runtime restarts, re-run the setup cells (Drive, install). Your data and trained model are safe on Drive.
- If you see a numpy / "binary incompatibility" error after installing, use **Runtime → Restart session** and run again from the top.
- Free Colab GPU time is limited; training in one sitting is easiest. Progress is backed up every 5 minutes if you get cut off.

## Responsible use

Train only on voices you have permission to use (your own, or someone who has agreed), and only process tracks you have the rights to.
