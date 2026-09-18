import { icon } from './icons.js';

/**
 * Reusable Canvas-based image cropper and resizer.
 * Supports arbitrary aspect ratios (e.g. 1:1 for avatars, 16:9 for covers).
 *
 * @param {File | Blob} file
 * @param {Object} options
 * @param {number} [options.aspectRatio=1]
 * @param {number} [options.outputWidth=512]
 * @param {number} [options.outputHeight=512]
 * @param {string} [options.title='Кадрирование изображения']
 * @returns {Promise<Blob | null>}
 */
/**
 * Decodes a local image File or Blob safely.
 *
 * Validates the file instance, size, and MIME type.
 * Note: Never set crossOrigin on blob: URLs, as it triggers unnecessary and failing
 * CORS security checks in browser engines, which causes img.onerror.
 *
 * @param {Blob | File} file
 * @returns {Promise<{ img: HTMLImageElement, cleanup: () => void }>}
 */
export function loadLocalImage(file) {
  return new Promise((resolve, reject) => {
    if (!file || !(file instanceof Blob)) {
      return reject(new Error('Не удалось прочитать изображение: неверный формат файла.'));
    }
    if (file.type && !file.type.startsWith('image/')) {
      return reject(new Error('Не удалось прочитать изображение: файл не является изображением.'));
    }
    if (file.size === 0) {
      return reject(new Error('Не удалось прочитать изображение: файл пуст.'));
    }

    let objectUrl = null;
    try {
      objectUrl = URL.createObjectURL(file);
    } catch {
      return reject(new Error('Не удалось прочитать изображение: ошибка создания объекта URL.'));
    }

    const img = new Image();
    // CRITICAL: Do NOT set img.crossOrigin on blob: URLs!
    // In browsers, crossOrigin='anonymous' on blob: URLs triggers CORS security violations
    // and causes img.onerror with "Не удалось прочитать изображение".

    let cleanedUp = false;
    const cleanup = () => {
      if (!cleanedUp) {
        cleanedUp = true;
        if (objectUrl) {
          URL.revokeObjectURL(objectUrl);
          objectUrl = null;
        }
      }
    };

    img.onload = () => {
      if (typeof img.decode === 'function') {
        img.decode()
          .then(() => resolve({ img, cleanup }))
          .catch(() => resolve({ img, cleanup }));
      } else {
        resolve({ img, cleanup });
      }
    };

    img.onerror = () => {
      cleanup();
      reject(new Error('Не удалось прочитать изображение'));
    };

    img.src = objectUrl;
  });
}

/**
 * Reusable Canvas-based image cropper and resizer.
 * Supports arbitrary aspect ratios (e.g. 1:1 for avatars, 16:9 for covers).
 *
 * @param {File | Blob} file
 * @param {Object} options
 * @param {number} [options.aspectRatio=1]
 * @param {number} [options.outputWidth=512]
 * @param {number} [options.outputHeight=512]
 * @param {string} [options.title='Кадрирование изображения']
 * @returns {Promise<Blob | null>}
 */
export async function editImage(file, { aspectRatio = 1, outputWidth = 512, outputHeight = 512, title = 'Кадрирование изображения' } = {}) {
  if (typeof document === 'undefined') {
    return null;
  }

  const { img, cleanup: cleanupImage } = await loadLocalImage(file);

  return new Promise((resolve, reject) => {
    // If no explicit ratio, preserve the image's natural aspect ratio
    const naturalRatio = (img.naturalWidth && img.naturalHeight) ? (img.naturalWidth / img.naturalHeight) : 1;
    const effectiveAspect = (aspectRatio !== null && aspectRatio !== undefined && aspectRatio > 0)
      ? aspectRatio
      : naturalRatio;
    const effectiveOutputH = (aspectRatio !== null && aspectRatio !== undefined && aspectRatio > 0)
      ? outputHeight
      : Math.round(outputWidth / effectiveAspect);
    const modal = document.createElement('div');
    modal.className = 'image-editor-modal dialog-scrim';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-label', title);

    modal.innerHTML = `
      <div class="image-editor-card dialog-box">
          <div class="image-editor-header">
            <h3>${title}</h3>
            <button type="button" class="quiet icon-button close-btn" aria-label="Закрыть">
              <span class="icon-close">✕</span>
            </button>
          </div>
          <div class="image-editor-body">
            <div class="crop-container">
              <canvas class="crop-canvas"></canvas>
              <div class="crop-overlay"></div>
            </div>
            <div class="image-editor-controls">
              <label class="zoom-slider-label">
                <span>Масштаб</span>
                <input type="range" class="zoom-range" min="1" max="3" step="0.01" value="1" aria-label="Масштаб изображения">
              </label>
            </div>
          </div>
          <div class="image-editor-footer">
            <button type="button" class="secondary cancel-btn">Отмена</button>
            <button type="button" class="primary save-btn">Применить</button>
          </div>
        </div>
      `;

      document.body.append(modal);

      const canvas = modal.querySelector('.crop-canvas');
      const ctx = canvas.getContext('2d');
      const cropContainer = modal.querySelector('.crop-container');
      const zoomRange = modal.querySelector('.zoom-range');
      const closeBtn = modal.querySelector('.close-btn');
      const cancelBtn = modal.querySelector('.cancel-btn');
      const saveBtn = modal.querySelector('.save-btn');

      // Crop viewport sizing
      const maxViewportW = Math.min(window.innerWidth - 64, 520);
      const viewportW = Math.max(260, maxViewportW);
      const viewportH = Math.round(viewportW / effectiveAspect);

      cropContainer.style.width = `${viewportW}px`;
      const canvasH = Math.min(viewportH, Math.round(window.innerHeight * 0.7));
      cropContainer.style.height = `${canvasH}px`;
      canvas.width = viewportW;
      canvas.height = canvasH;

      // Fit image initially so it covers the entire crop box
      const baseScale = Math.max(viewportW / img.width, viewportH / img.height);
      let userZoom = 1;
      let panX = 0;
      let panY = 0;

      // Center image initially
      panX = (viewportW - img.width * baseScale) / 2;
      panY = (viewportH - img.height * baseScale) / 2;

      function clampPan() {
        const curW = img.width * baseScale * userZoom;
        const curH = img.height * baseScale * userZoom;

        // Keep image covering the crop box
        const minX = viewportW - curW;
        const minY = viewportH - curH;

        panX = Math.min(0, Math.max(minX, panX));
        panY = Math.min(0, Math.max(minY, panY));
      }

      function draw() {
        clampPan();
        ctx.clearRect(0, 0, viewportW, viewportH);
        const curW = img.width * baseScale * userZoom;
        const curH = img.height * baseScale * userZoom;
        ctx.drawImage(img, panX, panY, curW, curH);
      }

      draw();

      // Pan handling with pointer events
      let isDragging = false;
      let startPointerX = 0;
      let startPointerY = 0;
      let startPanX = 0;
      let startPanY = 0;

      canvas.addEventListener('pointerdown', e => {
        isDragging = true;
        canvas.setPointerCapture(e.pointerId);
        startPointerX = e.clientX;
        startPointerY = e.clientY;
        startPanX = panX;
        startPanY = panY;
      });

      canvas.addEventListener('pointermove', e => {
        if (!isDragging) return;
        panX = startPanX + (e.clientX - startPointerX);
        panY = startPanY + (e.clientY - startPointerY);
        draw();
      });

      const stopDrag = e => {
        if (isDragging) {
          isDragging = false;
          try {
            canvas.releasePointerCapture(e.pointerId);
          } catch {}
        }
      };
      canvas.addEventListener('pointerup', stopDrag);
      canvas.addEventListener('pointercancel', stopDrag);

      // Zoom slider
      zoomRange.oninput = () => {
        const oldZoom = userZoom;
        userZoom = parseFloat(zoomRange.value);

        // Zoom relative to viewport center
        const centerX = viewportW / 2;
        const centerY = viewportH / 2;
        panX = centerX - ((centerX - panX) * userZoom) / oldZoom;
        panY = centerY - ((centerY - panY) * userZoom) / oldZoom;
        draw();
      };

      // Mouse wheel zoom
      canvas.addEventListener(
        'wheel',
        e => {
          e.preventDefault();
          const delta = e.deltaY < 0 ? 0.08 : -0.08;
          let nextVal = Math.min(3, Math.max(1, userZoom + delta));
          zoomRange.value = nextVal.toFixed(2);
          zoomRange.dispatchEvent(new Event('input'));
        },
        { passive: false }
      );

      function cleanup() {
        cleanupImage();
        modal.remove();
        document.removeEventListener('keydown', onKeyDown);
      }

      function onKeyDown(e) {
        if (e.key === 'Escape') {
          cleanup();
          resolve(null);
        }
      }
      document.addEventListener('keydown', onKeyDown);

      closeBtn.onclick = () => {
        cleanup();
        resolve(null);
      };
      cancelBtn.onclick = () => {
        cleanup();
        resolve(null);
      };

      saveBtn.onclick = () => {
        saveBtn.disabled = true;
        saveBtn.textContent = 'Обработка…';

        // Calculate source rectangle on original image
        const curScale = baseScale * userZoom;
        const srcX = -panX / curScale;
        const srcY = -panY / curScale;
        const srcW = viewportW / curScale;
        const srcH = canvasH / curScale;

        const outCanvas = document.createElement('canvas');
        outCanvas.width = outputWidth;
        outCanvas.height = effectiveOutputH;
        const outCtx = outCanvas.getContext('2d');

        outCtx.imageSmoothingEnabled = true;
        outCtx.imageSmoothingQuality = 'high';
        outCtx.drawImage(img, srcX, srcY, srcW, srcH, 0, 0, outputWidth, effectiveOutputH);

        const mimeType = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
        outCanvas.toBlob(
          blob => {
            cleanup();
            if (blob) {
              resolve(blob);
            } else {
              reject(new Error('Не удалось сгенерировать изображение'));
            }
          },
          mimeType,
          0.92
        );
      };
  });
}
