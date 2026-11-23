'use strict';
// Mineradio-TV: runs before the Mineradio modules load. Marks the page as a TV and seeds the
// first-run preferences a TV wants (no intro to click through, the lightest render tier).
(function () {
  document.documentElement.classList.add('mrtv');
  try {
    localStorage.setItem('mineradio-startup-fast-skip-v1', '1');
    if (!localStorage.getItem('mrtv-first-run-done')) localStorage.setItem('mrtv-first-run-done', String(Date.now()));
  } catch (e) { }
})();
