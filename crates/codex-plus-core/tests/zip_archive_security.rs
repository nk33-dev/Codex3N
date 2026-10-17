use std::io::{Cursor, Write};

use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

fn archive_with_file() -> Vec<u8> {
    let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
    writer
        .start_file(
            "project/README.md",
            SimpleFileOptions::default()
                .compression_method(CompressionMethod::Deflated)
                .unix_permissions(0o755),
        )
        .unwrap();
    writer.write_all("项目说明".as_bytes()).unwrap();
    writer.finish().unwrap().into_inner()
}

#[test]
fn zip_extracts_deflate_without_changing_text() {
    let directory = tempfile::tempdir().unwrap();
    let mut archive = ZipArchive::new(Cursor::new(archive_with_file())).unwrap();
    archive.extract(directory.path()).unwrap();
    assert_eq!(
        std::fs::read_to_string(directory.path().join("project/README.md")).unwrap(),
        "项目说明"
    );
}

#[test]
fn zip_rejects_symlinks_outside_extraction_directory() {
    let directory = tempfile::tempdir().unwrap();
    let outside = directory.path().join("outside.txt");
    std::fs::write(&outside, "原有内容").unwrap();
    let destination = directory.path().join("extracted");
    let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
    writer
        .add_symlink("escape", "../outside.txt", SimpleFileOptions::default())
        .unwrap();
    let bytes = writer.finish().unwrap().into_inner();
    let mut archive = ZipArchive::new(Cursor::new(bytes)).unwrap();
    assert!(archive.extract(&destination).is_err());
    assert!(!destination.join("escape").exists());
    assert_eq!(std::fs::read_to_string(&outside).unwrap(), "原有内容");
}

#[cfg(unix)]
#[test]
fn zip_masks_privileged_permission_bits() {
    use std::os::unix::fs::PermissionsExt;

    let mut bytes = archive_with_file();
    let central = bytes
        .windows(4)
        .position(|window| window == b"PK\x01\x02")
        .unwrap();
    // 写入攻击者可控的 ZIP Unix 属性，覆盖 SUID 和 SGID 位。
    bytes[central + 5] = 3;
    bytes[central + 38..central + 42].copy_from_slice(&((0o106755_u32) << 16).to_le_bytes());
    let directory = tempfile::tempdir().unwrap();
    ZipArchive::new(Cursor::new(bytes))
        .unwrap()
        .extract(directory.path())
        .unwrap();
    let permissions = std::fs::metadata(directory.path().join("project/README.md"))
        .unwrap()
        .permissions();
    assert_eq!(permissions.mode() & 0o7000, 0);
}
