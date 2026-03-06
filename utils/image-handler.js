/**
 * 이미지 처리 유틸리티
 * - Base64 변환
 * - URL에서 이미지 다운로드
 * - 에디터에 이미지 삽입
 */
const ImageHandler = {
  /**
   * File 객체를 Base64 데이터 URL로 변환
   */
  fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  },

  /**
   * Base64 데이터 URL을 Blob으로 변환
   */
  base64ToBlob(base64, mimeType = 'image/png') {
    const byteString = atob(base64.split(',')[1]);
    const ab = new ArrayBuffer(byteString.length);
    const ia = new Uint8Array(ab);
    for (let i = 0; i < byteString.length; i++) {
      ia[i] = byteString.charCodeAt(i);
    }
    return new Blob([ab], { type: mimeType });
  },

  /**
   * URL에서 이미지를 fetch하여 Base64로 변환
   */
  async urlToBase64(url) {
    try {
      const response = await fetch(url);
      const blob = await response.blob();
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
    } catch (error) {
      console.error('[TistoryAuto] 이미지 다운로드 실패:', url, error);
      throw error;
    }
  },

  /**
   * 에디터(contenteditable)에 이미지 HTML 태그 삽입
   */
  insertImageToEditor(editorDoc, imageData) {
    const { src, alt = '', width, height } = imageData;
    const img = editorDoc.createElement('img');
    img.src = src;
    img.alt = alt;
    if (width) img.width = width;
    if (height) img.height = height;
    img.style.maxWidth = '100%';
    img.style.height = 'auto';

    // 에디터 본문에 이미지 삽입
    const body = editorDoc.body || editorDoc.querySelector('#tinymce');
    if (body) {
      const p = editorDoc.createElement('p');
      p.appendChild(img);
      body.appendChild(p);
      return true;
    }
    return false;
  },

  /**
   * File input 요소를 통해 파일 업로드 트리거
   */
  triggerFileUpload(fileInput, file) {
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(file);
    fileInput.files = dataTransfer.files;

    // change 이벤트 발생시켜 업로드 트리거
    const event = new Event('change', { bubbles: true });
    fileInput.dispatchEvent(event);
  },

  /**
   * Clipboard API를 통해 이미지 붙여넣기
   */
  async pasteImageToEditor(editorElement, blob) {
    try {
      const clipboardItem = new ClipboardItem({ [blob.type]: blob });
      const pasteEvent = new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        clipboardData: new DataTransfer()
      });
      pasteEvent.clipboardData.items.add(new File([blob], 'image.png', { type: blob.type }));
      editorElement.dispatchEvent(pasteEvent);
      return true;
    } catch (error) {
      console.error('[TistoryAuto] 클립보드 붙여넣기 실패:', error);
      return false;
    }
  }
};

if (typeof window !== 'undefined') {
  window.__IMAGE_HANDLER = ImageHandler;
}
