# basic-pitch 音频转 MIDI 转写脚本（MIT 协议）
# 由安得云荟「薄荷 · 音频转换」的 MIDI 输出调用。
# 依赖：pip install basic-pitch（含 TensorFlow / pretty_midi 等）
# 用法：python transcribe.py <input.wav> <output.mid>
import sys
import os


def main():
    if len(sys.argv) < 3:
        print("usage: transcribe.py <input.wav> <output.mid>")
        sys.exit(1)

    in_path = sys.argv[1]
    out_mid = sys.argv[2]
    out_dir = os.path.dirname(out_mid) or "."
    basename = os.path.splitext(os.path.basename(out_mid))[0]

    # basic_pitch 把结果写到 out_dir，文件名基于输入文件基名
    from basic_pitch.inference import predict

    predict(
        in_path,
        out_dir,
        save_midi=True,
        sonify_midi=False,
        save_model=None,
        save_notes=None,
        save_note_vectors=None,
        save_activation=None,
        save_visualization=False,
    )

    src_base = os.path.splitext(os.path.basename(in_path))[0]
    candidates = [
        os.path.join(out_dir, src_base + "_basic_pitch.mid"),
        os.path.join(out_dir, basename + "_basic_pitch.mid"),
    ]
    found = next((c for c in candidates if os.path.exists(c)), None)
    if not found:
        mids = [os.path.join(out_dir, f) for f in os.listdir(out_dir) if f.endswith(".mid")]
        mids.sort(key=lambda f: os.path.getmtime(f))
        found = mids[-1] if mids else None
    if not found:
        print("ERROR: midi not generated")
        sys.exit(2)

    if os.path.abspath(found) != os.path.abspath(out_mid):
        import shutil
        shutil.move(found, out_mid)

    print("OK", out_mid)


if __name__ == "__main__":
    main()
