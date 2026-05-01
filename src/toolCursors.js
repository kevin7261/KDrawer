/** data-URL SVG cursor + hotspot；不支援時由瀏覽器 fallback 為 crosshair */

function svgCursor(inner, hx, hy) {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">${inner}</svg>`
  return `url("data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}") ${hx} ${hy}, crosshair`
}

const TOOL_CURSOR = {
  pencil: svgCursor(
    '<path fill="#162032" stroke="#f8fafc" stroke-width="1" d="M3 21l4-1 14-14-4-4L3 17v4z"/><path fill="#2563eb" d="M3 21v-3l2-2 3 3-2 2H3z"/><path fill="#e8edf6" d="m14 5 4 4"/>',
    3,
    20,
  ),
  pen: svgCursor(
    '<circle cx="12" cy="14" r="9" fill="rgba(37,99,235,0.22)" stroke="#2563eb" stroke-width="1.5"/><circle cx="12" cy="14" r="3.2" fill="#2563eb"/>',
    12,
    14,
  ),
  eraser: svgCursor(
    '<rect x="4.5" y="10" width="15" height="8" rx="1.5" fill="#f8fafc" stroke="#162032" stroke-width="1.5"/><path fill="#fca5a5" stroke="#162032" stroke-width="1" d="M7 10V7.5h10V10"/>',
    12,
    14,
  ),
  fill: svgCursor(
    '<path fill="#162032" stroke="#f8fafc" stroke-width="0.75" d="M12 2.5C9.2 8 4.5 9.8 4.5 14A7.5 7.5 0 0 0 19.5 14c0-4.2-4.7-6-7.5-11.5z"/><path fill="#2563eb" stroke="#162032" stroke-width="0.5" d="M6 17.5h12a6 6 0 0 1-12 0z"/>',
    12,
    16,
  ),
  pick: svgCursor(
    '<path fill="#162032" stroke="#f8fafc" stroke-width="1" d="M4.5 3.5L16 20l-5-8.5L4.5 8V3.5z"/><circle cx="9" cy="9.5" r="2.2" fill="#2563eb" stroke="#f8fafc" stroke-width="0.75"/>',
    4,
    4,
  ),
  line: svgCursor(
    '<path stroke="#162032" stroke-width="2.5" stroke-linecap="round" d="M4 17L17 6"/><circle cx="4" cy="17" r="1.75" fill="#2563eb"/><circle cx="17" cy="6" r="1.75" fill="#2563eb"/>',
    4,
    17,
  ),
  rect: svgCursor(
    '<rect x="5" y="7" width="14" height="12" fill="none" stroke="#162032" stroke-width="2"/><circle cx="5" cy="7" r="2" fill="#2563eb" stroke="#f8fafc" stroke-width="0.75"/>',
    5,
    7,
  ),
  ellipse: svgCursor(
    '<ellipse cx="12" cy="13" rx="9" ry="6" fill="none" stroke="#162032" stroke-width="2"/><circle cx="12" cy="7" r="2" fill="#2563eb" stroke="#f8fafc" stroke-width="0.75"/>',
    12,
    7,
  ),
  roundrect: svgCursor(
    '<rect x="5" y="8" width="14" height="10" rx="3.5" fill="none" stroke="#162032" stroke-width="2"/><circle cx="5" cy="11" r="2" fill="#2563eb" stroke="#f8fafc" stroke-width="0.75"/>',
    5,
    11,
  ),
}

/**
 * @param {string} tool
 * @returns {string}
 */
export function toolCursorCss(tool) {
  return TOOL_CURSOR[tool] || 'crosshair'
}
