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
export const SUPPORTED_IMAGE_MIMES = Object.freeze([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
]);

export const SUPPORTED_IMAGE_EXTENSIONS = Object.freeze([
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.gif',
]);

/**
 * Validates if the file is one of supported formats (PNG, JPEG, WebP, GIF).
 * Explicitly rejects HEIC/HEIF/AVIF or other unsupported formats.
 */
export function isSupportedImageFormat(file) {
  if (!file) return false;
  const type = (file.type || '').toLowerCase();
  const name = (file.name || '').toLowerCase();

  // Explicitly check unsupported modern / camera formats
  if (
    type === 'image/heic' ||
    type === 'image/heif' ||
    type === 'image/avif' ||
    /\.(heic|heif|avif)$/i.test(name)
  ) {
    return false;
  }

  if (SUPPORTED_IMAGE_MIMES.includes(type)) {
    return true;
  }

  // If MIME type is empty or generic binary, fallback to extension
  if (!type || type === 'application/octet-stream') {
    return SUPPORTED_IMAGE_EXTENSIONS.some(ext => name.endsWith(ext));
  }

  return false;
}

/**
 * Validates file instance, supported image formats, emptiness, and file size.
 * Throws actionable user-facing Russian errors before opening cropper.
 *
 * @param {Blob | File} file
 * @param {Object} [options]
 * @param {number} [options.maxSize=5242880]
 */
export function validateImageFile(file, { maxSize = 5 * 1024 * 1024 } = {}) {
  if (!file || !(file instanceof Blob)) {
    const err = new Error('Не удалось прочитать изображение: неверный формат файла.');
    err.stage = 'decode';
    throw err;
  }

  const type = (file.type || '').toLowerCase();
  const name = (file.name || '').toLowerCase();

  // If explicit non-image MIME type (like text/plain, application/pdf)
  if (type && !type.startsWith('image/') && type !== 'application/octet-stream' && !SUPPORTED_IMAGE_EXTENSIONS.some(ext => name.endsWith(ext))) {
    const err = new Error('Не удалось прочитать изображение: файл не является изображением.');
    err.stage = 'decode';
    throw err;
  }

  if (file.size === 0) {
    const err = new Error('Не удалось прочитать изображение: файл пуст.');
    err.stage = 'decode';
    throw err;
  }

  if (!isSupportedImageFormat(file)) {
    const err = new Error('Этот формат пока не поддерживается. Используй PNG, JPEG, WebP или GIF.');
    err.stage = 'decode';
    throw err;
  }

  if (maxSize && file.size > maxSize) {
    const err = new Error('Выбери PNG, JPEG, WebP или GIF до 5 МБ.');
    err.stage = 'decode';
    throw err;
  }
}

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
    try {
      validateImageFile(file);
    } catch (err) {
      return reject(err);
    }

    let objectUrl = null;
    try {
      objectUrl = URL.createObjectURL(file);
    } catch {
      const err = new Error('Не удалось декодировать изображение: ошибка создания объекта URL.');
      err.stage = 'decode';
      return reject(err);
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

    const handleDecodeFailure = () => {
      cleanup();
      // Only log safe metadata to debug console. NEVER log file contents.
      console.error('[Image Pipeline: decode]', {
        name: file.name || '',
        type: file.type || '',
        size: file.size || 0,
        lastModified: file.lastModified || null,
      });
      const err = new Error('Не удалось декодировать изображение.');
      err.stage = 'decode';
      reject(err);
    };

    img.onload = () => {
      if (typeof img.decode === 'function') {
        img.decode()
          .then(() => resolve({ img, cleanup }))
          .catch(() => handleDecodeFailure());
      } else {
        resolve({ img, cleanup });
      }
    };

    img.onerror = () => {
      handleDecodeFailure();
    };

    img.src = objectUrl;
  });
}

/**
 * Returns an offscreen canvas with the image rotated by the given angle in degrees,
 * or the original image if rotation is 0. Swaps dimensions for 90 and 270 degrees.
 *
 * @param {HTMLImageElement | HTMLCanvasElement} img
 * @param {number} rotation (0, 90, 180, 270)
 * @returns {{ source: HTMLImageElement | HTMLCanvasElement, width: number, height: number }}
 */
export function getRotatedSource(img, rotation = 0) {
  const normRot = ((rotation % 360) + 360) % 360;
  const w = img.naturalWidth || img.width || 0;
  const h = img.naturalHeight || img.height || 0;

  if (normRot === 0) {
    return {
      source: img,
      width: w,
      height: h,
    };
  }

  const isSwapped = normRot === 90 || normRot === 270;
  const canvas = document.createElement('canvas');
  canvas.width = isSwapped ? h : w;
  canvas.height = isSwapped ? w : h;
  const ctx = canvas.getContext('2d');

  if (ctx) {
    ctx.save();
    if (normRot === 90) {
      ctx.translate(h, 0);
      ctx.rotate(Math.PI / 2);
    } else if (normRot === 180) {
      ctx.translate(w, h);
      ctx.rotate(Math.PI);
    } else if (normRot === 270) {
      ctx.translate(0, w);
      ctx.rotate((3 * Math.PI) / 2);
    }
    ctx.drawImage(img, 0, 0);
    ctx.restore();
  }

  return {
    source: canvas,
    width: canvas.width,
    height: canvas.height,
  };
}

/**
 * Reusable Canvas-based image cropper and resizer with rotation and circle/rect mask support.
 *
 * @param {File | Blob} file
 * @param {Object} options
 * @param {number | null} [options.aspectRatio=1]
 * @param {number} [options.outputWidth=512]
 * @param {number} [options.outputHeight=512]
 * @param {'rect' | 'circle'} [options.cropShape='rect']
 * @param {string} [options.title='Кадрирование изображения']
 * @returns {Promise<Blob | null>}
 */
export async function editImage(file, {
  aspectRatio = 1,
  outputWidth = 512,
  outputHeight = 512,
  cropShape = 'rect',
  title = 'Кадрирование изображения'
} = {}) {
  if (typeof document === 'undefined') {
    return null;
  }

  validateImageFile(file);

  const { img, cleanup: cleanupImage } = await loadLocalImage(file);

  return new Promise((resolve, reject) => {
    const isFixedAspect = aspectRatio !== null && aspectRatio !== undefined && aspectRatio > 0;
    const isCircle = cropShape === 'circle';

    const modal = document.createElement('div');
    modal.className = 'image-editor-modal dialog-scrim';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-label', title);

    modal.innerHTML = `
      <div class="image-editor-card dialog-box">
        <div class="image-editor-header">
          <h3>${title}</h3>
          <button type="button" class="quiet icon-button close-btn" aria-label="Закрыть" title="Закрыть">
            <span class="icon-close">✕</span>
          </button>
        </div>
        <div class="image-editor-body">
          <div class="crop-container">
            <canvas class="crop-canvas"></canvas>
            <div class="crop-overlay ${isCircle ? 'crop-overlay--circle' : 'crop-overlay--rect'}"></div>
          </div>
          <div class="image-editor-controls">
            <div class="image-editor-toolbar">
              <div class="image-editor-transform-actions">
                <button type="button" class="quiet icon-button rotate-left-btn" aria-label="Повернуть влево на 90°" title="Повернуть влево на 90°"></button>
                <button type="button" class="quiet icon-button rotate-right-btn" aria-label="Повернуть вправо на 90°" title="Повернуть вправо на 90°"></button>
                <button type="button" class="quiet icon-button reset-btn" aria-label="Сбросить" title="Сбросить"></button>
              </div>
              <label class="zoom-slider-label">
                <span>Масштаб</span>
                <input type="range" class="zoom-range" min="1" max="3" step="0.01" value="1" aria-label="Масштаб изображения">
              </label>
            </div>
          </div>
        </div>
        <div class="image-editor-footer">
          <button type="button" class="secondary cancel-btn">Отмена</button>
          <button type="button" class="primary save-btn">Применить</button>
        </div>
      </div>
    `;

    const previousActiveElement = document.activeElement;
    document.body.classList.add('modal-open');
    document.body.append(modal);

    const canvas = modal.querySelector('.crop-canvas');
    const ctx = canvas.getContext('2d');
    const cropContainer = modal.querySelector('.crop-container');
    const zoomRange = modal.querySelector('.zoom-range');
    const closeBtn = modal.querySelector('.close-btn');
    const cancelBtn = modal.querySelector('.cancel-btn');
    const saveBtn = modal.querySelector('.save-btn');
    const rotateLeftBtn = modal.querySelector('.rotate-left-btn');
    const rotateRightBtn = modal.querySelector('.rotate-right-btn');
    const resetBtn = modal.querySelector('.reset-btn');

    // Focus primary action inside cropper
    saveBtn.focus();

    // Attach icons to toolbar buttons
    rotateLeftBtn.append(icon('rotateLeft'));
    rotateRightBtn.append(icon('rotateRight'));
    resetBtn.append(icon('reset'), document.createTextNode('Сброс'));

    // State
    let rotation = 0;
    let userZoom = 1;
    let panX = 0;
    let panY = 0;
    let baseScale = 1;
    let viewportW = 260;
    let viewportH = 260;
    let currentSource = getRotatedSource(img, 0);

    function recalculateViewport() {
      const effectiveAspect = isFixedAspect ? aspectRatio : (currentSource.width / currentSource.height);
      const parent = cropContainer.parentElement;
      let parentContentW = 0;
      if (parent && parent.clientWidth > 0) {
        const computed = window.getComputedStyle(parent);
        const padLeft = parseFloat(computed.paddingLeft) || 0;
        const padRight = parseFloat(computed.paddingRight) || 0;
        parentContentW = parent.clientWidth - padLeft - padRight;
      }
      if (!parentContentW || parentContentW <= 0) {
        parentContentW = window.innerWidth - 72;
      }
      const maxViewportW = Math.min(Math.floor(parentContentW), 520);
      viewportW = Math.max(180, maxViewportW);
      viewportH = Math.round(viewportW / effectiveAspect);

      const maxH = Math.round(window.innerHeight * 0.55);
      if (viewportH > maxH) {
        viewportH = maxH;
        viewportW = Math.round(viewportH * effectiveAspect);
      }

      cropContainer.style.width = `${viewportW}px`;
      cropContainer.style.height = `${viewportH}px`;
      canvas.width = viewportW;
      canvas.height = viewportH;
    }

    function recalculateGeometry({ resetZoom = false } = {}) {
      baseScale = Math.max(viewportW / currentSource.width, viewportH / currentSource.height);
      if (resetZoom) {
        userZoom = 1;
        zoomRange.value = '1';
      }
      const curScale = baseScale * userZoom;
      const curW = currentSource.width * curScale;
      const curH = currentSource.height * curScale;

      panX = (viewportW - curW) / 2;
      panY = (viewportH - curH) / 2;
      clampPan();
    }

    function clampPan() {
      const curScale = baseScale * userZoom;
      const curW = currentSource.width * curScale;
      const curH = currentSource.height * curScale;

      // Keep image covering the crop viewport without empty gaps
      const minX = viewportW - curW;
      const minY = viewportH - curH;

      panX = Math.min(0, Math.max(minX, panX));
      panY = Math.min(0, Math.max(minY, panY));
    }

    function drawPreview() {
      clampPan();
      ctx.clearRect(0, 0, viewportW, viewportH);
      const curScale = baseScale * userZoom;
      const curW = currentSource.width * curScale;
      const curH = currentSource.height * curScale;
      ctx.drawImage(currentSource.source, panX, panY, curW, curH);
    }

    function rotateLeft() {
      rotation = (rotation + 270) % 360;
      applyRotation();
    }

    function rotateRight() {
      rotation = (rotation + 90) % 360;
      applyRotation();
    }

    function applyRotation() {
      currentSource = getRotatedSource(img, rotation);
      if (!isFixedAspect) {
        recalculateViewport();
      }
      recalculateGeometry({ resetZoom: true });
      drawPreview();
    }

    function resetTransform() {
      rotation = 0;
      currentSource = getRotatedSource(img, 0);
      if (!isFixedAspect) {
        recalculateViewport();
      }
      recalculateGeometry({ resetZoom: true });
      drawPreview();
    }

    // Initial setup
    recalculateViewport();
    recalculateGeometry({ resetZoom: true });
    drawPreview();

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
      drawPreview();
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
      drawPreview();
    };

    // Mouse wheel zoom
    canvas.addEventListener(
      'wheel',
      e => {
        e.preventDefault();
        const delta = e.deltaY < 0 ? 0.08 : -0.08;
        const nextVal = Math.min(3, Math.max(1, userZoom + delta));
        zoomRange.value = nextVal.toFixed(2);
        zoomRange.dispatchEvent(new Event('input'));
      },
      { passive: false }
    );

    // Button event listeners
    rotateLeftBtn.onclick = rotateLeft;
    rotateRightBtn.onclick = rotateRight;
    resetBtn.onclick = resetTransform;

    function cleanup() {
      cleanupImage();
      document.body.classList.remove('modal-open');
      modal.remove();
      document.removeEventListener('keydown', onKeyDown, true);
      if (previousActiveElement && typeof previousActiveElement.focus === 'function' && previousActiveElement.isConnected) {
        try {
          previousActiveElement.focus();
        } catch {
          // Ignore focus errors
        }
      }
    }

    function onKeyDown(e) {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation?.();
        cleanup();
        resolve(null);
      }
    }
    document.addEventListener('keydown', onKeyDown, true);

    closeBtn.onclick = () => {
      cleanup();
      resolve(null);
    };
    cancelBtn.onclick = () => {
      cleanup();
      resolve(null);
    };

    function exportCrop() {
      saveBtn.disabled = true;
      saveBtn.textContent = 'Обработка…';

      try {
        const curScale = baseScale * userZoom;
        const srcX = -panX / curScale;
        const srcY = -panY / curScale;
        const srcW = viewportW / curScale;
        const srcH = viewportH / curScale;

        let targetOutW = outputWidth;
        let targetOutH = outputHeight;
        if (isFixedAspect) {
          targetOutW = outputWidth;
          targetOutH = outputHeight || Math.round(outputWidth / aspectRatio);
        } else {
          const isRotated90 = rotation === 90 || rotation === 270;
          const maxW = isRotated90 && outputHeight ? outputHeight : outputWidth;
          const maxH = isRotated90 && outputHeight ? outputWidth : (outputHeight || outputWidth);
          const aspect = currentSource.width / currentSource.height;
          if (aspect >= 1) {
            targetOutW = Math.min(maxW, Math.round(maxH * aspect));
            targetOutH = Math.round(targetOutW / aspect);
          } else {
            targetOutH = Math.min(maxH, Math.round(maxW / aspect));
            targetOutW = Math.round(targetOutH * aspect);
          }
        }

        const outCanvas = document.createElement('canvas');
        outCanvas.width = targetOutW;
        outCanvas.height = targetOutH;
        const outCtx = outCanvas.getContext('2d');

        if (!outCtx) {
          cleanup();
          console.error('[Image Pipeline: crop]', 'Canvas 2D context unavailable');
          const err = new Error('Не удалось выполнить кадрирование изображения.');
          err.stage = 'crop';
          reject(err);
          return;
        }

        outCtx.imageSmoothingEnabled = true;
        outCtx.imageSmoothingQuality = 'high';
        outCtx.drawImage(currentSource.source, srcX, srcY, srcW, srcH, 0, 0, targetOutW, targetOutH);

        const mimeType = file.type === 'image/png' ? 'image/png' : (file.type === 'image/webp' ? 'image/webp' : 'image/jpeg');
        outCanvas.toBlob(
          blob => {
            cleanup();
            if (blob) {
              resolve(blob);
            } else {
              console.error('[Image Pipeline: encode]', { mimeType });
              const err = new Error('Не удалось закодировать изображение.');
              err.stage = 'encode';
              reject(err);
            }
          },
          mimeType,
          0.92
        );
      } catch (cropErr) {
        cleanup();
        console.error('[Image Pipeline: crop]', cropErr?.message || cropErr);
        const err = new Error('Не удалось выполнить кадрирование изображения.');
        err.stage = 'crop';
        reject(err);
      }
    }

    saveBtn.onclick = exportCrop;
  });
}
