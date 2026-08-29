# Magic5 preview surface

This directory is an intentionally isolated copy of the DSH preview web
surface used inside `../magic5-preview.html`.

Keep its HTML, CSS, JavaScript, fonts, icons, and preview bridge changes here.
Do not import the production-facing `../index.html`, `../styles.css`, or
`../app.js`; the separation lets the Honor phone mock evolve independently
from the other web surface.
