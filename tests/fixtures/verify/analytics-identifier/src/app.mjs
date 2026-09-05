// Fixture proving the "analytics-identifier" rule bites: a classic
// GA4-style snippet, the exact shape a real build must never contain.
window.dataLayer = window.dataLayer || [];
function gtag() {
  window.dataLayer.push(arguments);
}
gtag('js', new Date());
gtag('config', 'G-FAKEID123');
