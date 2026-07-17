use std::fs;
use std::path::Path;

fn main() {
    let path = std::env::args().nth(1).expect("usage: dump_pptx <file.pptx>");
    let bytes = fs::read(&path).expect("read pptx");
    let media_dir = Path::new(".").join("dump_media");
    fs::create_dir_all(&media_dir).ok();
    // 调用 lib 中的 pptx_to_json
    let json = andengyuanhua_lib::services::pptx_import::pptx_to_json(&bytes, &media_dir)
        .expect("pptx_to_json failed");
    let out = Path::new("dump_import.json");
    fs::write(out, &json).expect("write json");
    println!("wrote dump_import.json ({} bytes)", json.len());
}
