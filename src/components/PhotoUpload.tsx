import { useRef, useState } from "react";

interface Props {
  title: string;
  description: string;
  onChange: (files: File[]) => void;
  submitted?: boolean;
  required?: boolean;
}

export function PhotoUpload({
  title,
  description,
  onChange,
  submitted = false,
  required = true
}: Props) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [files, setFiles] = useState<File[]>([]);

  const appendFiles = (fileList: FileList | null) => {
    if (!fileList?.length || submitted) return;

    const next = [...files, ...Array.from(fileList)];
    setFiles(next);
    onChange(next);

    if (inputRef.current) inputRef.current.value = "";
  };

  const removeFile = (index: number) => {
    if (submitted) return;
    const next = files.filter((_, i) => i !== index);
    setFiles(next);
    onChange(next);
  };

  return (
    <div className="photo-box">
      <div className="photo-title-row">
        <div>
          <strong>{title}</strong>
          <span className={required ? "must" : "optional"}>
            {required ? "必传" : "选填"}
          </span>
        </div>
        <span className="camera">📷</span>
      </div>

      <div className="watermark-note">
        <b>请使用水印相机拍照后上传</b>
        <small>🚫 禁止使用普通相机拍摄</small>
      </div>

      <p>{description}</p>

      <input
        ref={inputRef}
        className="file-input"
        type="file"
        accept="image/*"
        multiple
        onChange={(event) => appendFiles(event.target.files)}
      />

      <button
        className="upload-button"
        type="button"
        disabled={submitted}
        onClick={() => inputRef.current?.click()}
      >
        ＋ 添加水印相机照片
      </button>

      <div className="photo-count">
        {files.length ? `已选择 ${files.length} 张照片` : "尚未上传照片"}
      </div>

      {files.length > 0 && (
        <div className="file-list">
          {files.map((file, index) => (
            <div className="file-row" key={`${file.name}-${index}`}>
              <span title={file.name}>
                {index + 1}. {file.name}
              </span>
              {!submitted && (
                <button type="button" onClick={() => removeFile(index)}>
                  删除
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
