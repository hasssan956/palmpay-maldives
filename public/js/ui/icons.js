// Hand-drawn 24px stroke icons. Inline SVG keeps the app dependency-free.
const P = {
  palm: '<path d="M8 12.5V5.8a1.4 1.4 0 0 1 2.8 0V11"/><path d="M10.8 10.6V4.4a1.4 1.4 0 0 1 2.8 0v6.2"/><path d="M13.6 10.8V5.6a1.4 1.4 0 0 1 2.8 0v6.6"/><path d="M16.4 12.2V8.6a1.4 1.4 0 0 1 2.8 0v5.2a7.2 7.2 0 0 1-7.2 7.2h-.6a6 6 0 0 1-4.6-2.2l-3-3.7a1.5 1.5 0 0 1 2.2-2l2 1.7"/>',
  home: '<path d="M4 10.5 12 4l8 6.5V19a1 1 0 0 1-1 1h-4.5v-5.5h-5V20H5a1 1 0 0 1-1-1z"/>',
  list: '<path d="M8 7h12M8 12h12M8 17h12"/><circle cx="4.5" cy="7" r="1"/><circle cx="4.5" cy="12" r="1"/><circle cx="4.5" cy="17" r="1"/>',
  more: '<circle cx="5" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="19" cy="12" r="1.4"/>',
  user: '<circle cx="12" cy="8.5" r="3.8"/><path d="M4.5 20a7.5 7.5 0 0 1 15 0"/>',
  bell: '<path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 2h-15z"/><path d="M10 20.5a2.2 2.2 0 0 0 4 0"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>',
  eyeOff: '<path d="M3 3l18 18"/><path d="M10.6 5.6A9.6 9.6 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a17 17 0 0 1-3 3.7M6.3 6.9A16 16 0 0 0 2.5 12S6 18.5 12 18.5a9 9 0 0 0 4-.9"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
  send: '<path d="M7 17 17 7"/><path d="M8.5 7H17v8.5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  topup: '<rect x="3.5" y="6" width="17" height="12.5" rx="2.5"/><path d="M3.5 10h17"/><path d="M15 14.5h2.5"/>',
  shield: '<path d="M12 3.5 19 6v5.6c0 4.4-3 7.6-7 8.9-4-1.3-7-4.5-7-8.9V6z"/><path d="m9 12 2.2 2.2L15.5 10"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  chevron: '<path d="m9.5 6 6 6-6 6"/>',
  back: '<path d="m14.5 6-6 6 6 6"/>',
  flip: '<path d="M4 9a8 8 0 0 1 14.3-3.3L20 7.5"/><path d="M20 4v3.5h-3.5"/><path d="M20 15a8 8 0 0 1-14.3 3.3L4 16.5"/><path d="M4 20v-3.5h3.5"/>',
  store: '<path d="M4 9.5 5.5 4.5h13L20 9.5"/><path d="M4 9.5a2.7 2.7 0 0 0 5.3 0 2.7 2.7 0 0 0 5.4 0 2.7 2.7 0 0 0 5.3 0"/><path d="M5.5 12v7.5h13V12"/><path d="M10 19.5v-4.5h4v4.5"/>',
  userPlus: '<circle cx="10" cy="8.5" r="3.8"/><path d="M2.5 20a7.5 7.5 0 0 1 12.6-5.5"/><path d="M18.5 14v6M15.5 17h6"/>',
  receipt: '<path d="M6 3.5h12v17l-2-1.4-2 1.4-2-1.4-2 1.4-2-1.4-2 1.4z"/><path d="M9 8h6M9 12h6"/>',
  refresh: '<path d="M20 11.5A8 8 0 1 0 17.7 17"/><path d="M20 5.5v6h-6"/>',
  arrowIn: '<path d="M17 7 7 17"/><path d="M15.5 17H7V8.5"/>',
  logout: '<path d="M14 4.5h4.5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H14"/><path d="M10 16.5 5.5 12 10 7.5"/><path d="M5.5 12H15"/>',
};

export function icon(name, cls = '') {
  return `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[name] || ''}</svg>`;
}

// Brand mark: an open ring and a rising ripple, like a palm settling on water.
export const brandMark = (cls = 'brand-mark') => `
<svg class="${cls}" viewBox="0 0 40 40" aria-hidden="true">
  <rect width="40" height="40" rx="12" fill="#2ec4b6"/>
  <path d="M20 9.5a10.5 10.5 0 1 1-10.5 10.5" fill="none" stroke="#0a2342" stroke-width="3.2" stroke-linecap="round"/>
  <path d="M20 15a5 5 0 1 1-5 5" fill="none" stroke="#0a2342" stroke-width="3.2" stroke-linecap="round"/>
  <circle cx="20" cy="20" r="1.9" fill="#0a2342"/>
  <circle cx="11.6" cy="11.6" r="2.2" fill="#ffc857"/>
</svg>`;

// Outline the customer lines their hand up with. Drawn as palm + five capsules.
export const palmGuide = () => `
<svg class="guide" viewBox="0 0 200 200" fill="none" stroke="currentColor" stroke-width="2.4" stroke-dasharray="6 7" stroke-linecap="round" aria-hidden="true">
  <path d="M62 112c0-14 6-22 6-22h66s6 8 6 22v18c0 30-18 48-39 48s-39-18-39-48z"/>
  <rect x="64" y="34" width="17" height="64" rx="8.5" transform="rotate(-6 72 66)"/>
  <rect x="85" y="20" width="17" height="74" rx="8.5"/>
  <rect x="106" y="24" width="17" height="70" rx="8.5" transform="rotate(4 114 59)"/>
  <rect x="126" y="40" width="15" height="58" rx="7.5" transform="rotate(10 133 69)"/>
  <rect x="34" y="98" width="16" height="52" rx="8" transform="rotate(-42 42 124)"/>
</svg>`;
