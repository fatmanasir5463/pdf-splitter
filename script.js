/* global pdfjsLib, PDFLib, JSZip */
(() => {
  "use strict";

  const $ = (sel, root = document) => root.querySelector(sel);

  function uid() {
    return Math.random().toString(16).slice(2) + Date.now().toString(16);
  }

  function clamp(n, min, max) {
    return Math.max(min, Math.min(max, n));
  }

  function formatBytes(n) {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(2)} MB`;
  }

  function downloadBlob(blob, filename) {
    const a = document.createElement("a");
    const url = URL.createObjectURL(blob);
    a.href = url;
    a.download = filename;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Important: delay revoke so large ZIP/PDF downloads don't get corrupted.
    setTimeout(() => URL.revokeObjectURL(url), 15000);
  }

  function bytesFromFile(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onerror = () => reject(new Error("Could not read file"));
      r.onload = () => resolve(new Uint8Array(r.result));
      r.readAsArrayBuffer(file);
    });
  }

  function blobFromBytes(bytes, mime) {
    return new Blob([bytes], { type: mime });
  }

  function getInputFiles(inputEl) {
    const fromInput = inputEl && inputEl.files ? Array.from(inputEl.files) : [];
    const dropped = inputEl && inputEl._droppedFiles ? Array.from(inputEl._droppedFiles) : [];
    return fromInput.length ? fromInput : dropped;
  }

  function safeBaseName(name) {
    const base = (name || "file").replace(/\.[^/.]+$/, "");
    return base.replace(/[^\w\-(). ]+/g, "_").trim() || "file";
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => {
      const map = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
      return map[c] || c;
    });
  }

  function escapeAttr(s) {
    return escapeHtml(s).replace(/`/g, "&#96;");
  }

  function setProgress(row, bar, pctEl, lblEl, on, pct, label) {
    row.hidden = !on;
    const p = clamp(Math.round(pct), 0, 100);
    bar.style.width = `${p}%`;
    pctEl.textContent = `${p}%`;
    if (label != null) lblEl.textContent = label;
  }

  function ensurePdfJs() {
    if (typeof pdfjsLib === "undefined") throw new Error("pdf.js failed to load");
    pdfjsLib.GlobalWorkerOptions.workerSrc =
      "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/pdf.worker.min.js";
  }

  function toArrayBuffer(uint8) {
    if (uint8 instanceof Uint8Array) {
      return uint8.buffer.slice(uint8.byteOffset, uint8.byteOffset + uint8.byteLength);
    }
    return uint8;
  }

  async function loadPdfJsDocument(dataBytes) {
    ensurePdfJs();
    const data = toArrayBuffer(dataBytes);
    try {
      return await pdfjsLib.getDocument({ data }).promise;
    } catch {
      // Fallback for environments where worker fetch fails.
      return await pdfjsLib.getDocument({ data, disableWorker: true }).promise;
    }
  }

  function ensurePdfLib() {
    if (typeof PDFLib === "undefined") throw new Error("pdf-lib failed to load");
  }

  function ensureZip() {
    if (typeof JSZip === "undefined") throw new Error("JSZip failed to load");
  }

  function hasZip() {
    return typeof JSZip !== "undefined";
  }

  async function renderPageToCanvas(pdfDoc, pageNumber, scale) {
    const page = await pdfDoc.getPage(pageNumber);
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d", { alpha: false });
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    const task = page.render({ canvasContext: ctx, viewport });
    await task.promise;
    return canvas;
  }

  function canvasToBlob(canvas, type, quality) {
    return new Promise((resolve, reject) => {
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error("Could not encode image"))),
        type,
        quality,
      );
    });
  }

  function parsePageGroups(input, maxPage) {
    const text = String(input || "").trim();
    if (!text) return [];
    const parts = text
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean);
    const groups = [];
    for (const part of parts) {
      const m = part.match(/^(\d+)\s*-\s*(\d+)$/);
      if (m) {
        let a = parseInt(m[1], 10);
        let b = parseInt(m[2], 10);
        if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
        if (a > b) [a, b] = [b, a];
        a = clamp(a, 1, maxPage);
        b = clamp(b, 1, maxPage);
        const pages = [];
        for (let i = a; i <= b; i++) pages.push(i);
        groups.push(pages);
        continue;
      }
      const n = parseInt(part, 10);
      if (Number.isFinite(n)) groups.push([clamp(n, 1, maxPage)]);
    }
    return groups;
  }

  function parsePageIndices(input, maxPage) {
    const text = String(input || "").trim();
    if (!text) return [];
    const parts = text
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean);
    const set = new Set();
    for (const part of parts) {
      const m = part.match(/^(\d+)\s*-\s*(\d+)$/);
      if (m) {
        let a = parseInt(m[1], 10);
        let b = parseInt(m[2], 10);
        if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
        if (a > b) [a, b] = [b, a];
        for (let i = clamp(a, 1, maxPage); i <= clamp(b, 1, maxPage); i++) set.add(i);
      } else {
        const n = parseInt(part, 10);
        if (Number.isFinite(n)) set.add(clamp(n, 1, maxPage));
      }
    }
    return Array.from(set).sort((a, b) => a - b);
  }

  function initDropzones() {
    for (const dz of document.querySelectorAll(".dropzone")) {
      const input = $(".dropzone__input", dz);
      dz.addEventListener("dragenter", (e) => {
        e.preventDefault();
        dz.classList.add("is-dragover");
      });
      dz.addEventListener("dragover", (e) => {
        e.preventDefault();
        dz.classList.add("is-dragover");
      });
      dz.addEventListener("dragleave", () => dz.classList.remove("is-dragover"));
      dz.addEventListener("drop", (e) => {
        e.preventDefault();
        dz.classList.remove("is-dragover");
        const files = Array.from(e.dataTransfer?.files || []);
        input._droppedFiles = files;
        try {
          if (window.DataTransfer) {
            const dt = new DataTransfer();
            for (const f of files) dt.items.add(f);
            input.files = dt.files;
          }
        } catch {
          /* ignore */
        }
        input.dispatchEvent(new Event("change", { bubbles: true }));
      });
    }
  }

  function initTheme() {
    const app = $("#app");
    const body = document.body;
    const toggle = $("#themeToggle");
    const label = $("#themeLabel");
    const key = "pdf_toolkit_theme_light";

    function apply(isLight) {
      // Apply theme variables to <body> so background colors switch correctly.
      body.classList.toggle("theme-light", isLight);
      app.classList.toggle("theme-light", isLight);
      // Requirement now: toggle OFF = dark theme, toggle ON = light theme.
      toggle.checked = isLight;
      label.textContent = isLight ? "Light" : "Dark";
      localStorage.setItem(key, isLight ? "1" : "0");
    }

    const saved = localStorage.getItem(key);
    if (saved === "1") apply(true);
    else if (saved === "0") apply(false);
    else apply(false);

    toggle.addEventListener("change", () => apply(toggle.checked));
  }

  function initNavScrollSpy() {
    const links = Array.from(document.querySelectorAll(".nav__link"));
    const sections = links
      .map((a) => document.querySelector(a.getAttribute("href")))
      .filter(Boolean);

    function setActive(id) {
      for (const a of links) {
        a.classList.toggle("is-active", a.getAttribute("href") === `#${id}`);
      }
    }

    function focusTool(section) {
      if (!section) return;
      // Focus first file input / control to make the selected tool feel "opened".
      const dropInput = section.querySelector(".dropzone__input");
      if (dropInput && typeof dropInput.focus === "function") {
        dropInput.focus({ preventScroll: true });
        return;
      }
      const firstField = section.querySelector("input, select, textarea, button");
      if (firstField && typeof firstField.focus === "function") {
        firstField.focus({ preventScroll: true });
      }
    }

    links.forEach((a) => {
      a.addEventListener("click", (e) => {
        e.preventDefault();
        const id = a.getAttribute("href").slice(1);
        setActive(id);
        const section = document.getElementById(id);
        if (section) {
          for (const s of sections) s.classList.remove("is-focused");
          section.classList.add("is-focused");
          section.scrollIntoView({ behavior: "smooth", block: "start" });
          if (window.history && window.history.replaceState) {
            window.history.replaceState(null, "", `#${id}`);
          }
          // Make sure the user can immediately use the selected tool.
          setTimeout(() => focusTool(section), 250);
        }
      });
    });

    if (sections.length) setActive(sections[0].id);
    if (sections.length) {
      for (const s of sections) s.classList.remove("is-focused");
      sections[0].classList.add("is-focused");
    }

    if (!sections.length || !("IntersectionObserver" in window)) return;

    const io = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio);
        if (visible[0]) setActive(visible[0].target.id);
        for (const s of sections) s.classList.remove("is-focused");
        if (visible[0]) {
          visible[0].target.classList.add("is-focused");
        }
      },
      { root: null, rootMargin: "-20% 0px -55% 0px", threshold: [0, 0.1, 0.25, 0.5] },
    );

    sections.forEach((s) => io.observe(s));
  }

  function makeReorderable(container, getItems, setItems, render) {
    let dragId = null;
    container.addEventListener("dragstart", (e) => {
      const item = e.target.closest(".fileitem[draggable='true']");
      if (!item) return;
      dragId = item.dataset.id;
      item.classList.add("is-dragging");
      e.dataTransfer.effectAllowed = "move";
    });
    container.addEventListener("dragend", (e) => {
      const item = e.target.closest(".fileitem");
      if (item) item.classList.remove("is-dragging");
      dragId = null;
    });
    container.addEventListener("dragover", (e) => {
      e.preventDefault();
      const over = e.target.closest(".fileitem[draggable='true']");
      if (!over || !dragId) return;
      const overId = over.dataset.id;
      if (overId === dragId) return;
      const items = getItems();
      const from = items.findIndex((x) => x.id === dragId);
      const to = items.findIndex((x) => x.id === overId);
      if (from < 0 || to < 0) return;
      const copy = items.slice();
      const [moved] = copy.splice(from, 1);
      copy.splice(to, 0, moved);
      setItems(copy);
      render();
    });
  }

  function showFileMeta(el, file) {
    if (!file) {
      el.hidden = true;
      el.textContent = "";
      return;
    }
    el.hidden = false;
    el.innerHTML = `<strong>${escapeHtml(file.name)}</strong> · ${formatBytes(file.size)}`;
  }

  function showFilesMeta(el, files) {
    if (!files || !files.length) {
      el.hidden = true;
      el.textContent = "";
      return;
    }
    el.hidden = false;
    const total = files.reduce((s, f) => s + f.size, 0);
    el.innerHTML = `${files.length} file(s) · ${formatBytes(total)}`;
  }

  // --- Split ---
  function initSplit() {
    const input = $("#splitInput");
    const ranges = $("#splitRanges");
    const btn = $("#splitBtn");
    const clear = $("#splitClear");
    const meta = $("#splitFileMeta");
    const preview = $("#splitPreview");
    const row = $("#splitProg");
    const bar = $("#splitProgBar");
    const pct = $("#splitProgPct");
    const lbl = $("#splitProgLbl");

    let pdfBytes = null;
    let file = null;
    let pageCount = 0;

    function reset() {
      pdfBytes = null;
      file = null;
      pageCount = 0;
      input.value = "";
      ranges.value = "";
      btn.disabled = true;
      clear.disabled = true;
      meta.hidden = true;
      preview.innerHTML = `<span class="muted">Preview appears after upload.</span>`;
      setProgress(row, bar, pct, lbl, false, 0, "");
    }

    input.addEventListener("change", async () => {
      const f = getInputFiles(input)[0];
      if (!f) return;
      try {
        ensurePdfLib();
        pdfBytes = await bytesFromFile(f);
        file = f;
        const doc = await PDFLib.PDFDocument.load(pdfBytes);
        pageCount = doc.getPageCount();
        showFileMeta(meta, file);
        btn.disabled = false;
        clear.disabled = false;
        preview.innerHTML = `<span class="muted">${pageCount} page(s). Enter ranges, then split.</span>`;
      } catch (e) {
        pdfBytes = null;
        file = null;
        pageCount = 0;
        btn.disabled = true;
        clear.disabled = true;
        showFileMeta(meta, null);
        preview.innerHTML = `<span class="muted">Error: ${escapeHtml(e.message || e)}</span>`;
        setProgress(row, bar, pct, lbl, false, 0, "");
      }
    });

    btn.addEventListener("click", async () => {
      if (!pdfBytes || !file) return;
      const groups = parsePageGroups(ranges.value, pageCount);
      const finalGroups =
        groups.length > 0 ? groups : Array.from({ length: pageCount }, (_, i) => [i + 1]);
      if (!groups.length) {
        preview.innerHTML = `<span class="muted">No ranges entered, splitting all pages individually.</span>`;
      }
      ensurePdfLib();
      btn.disabled = true;
      clear.disabled = true;
      setProgress(row, bar, pct, lbl, true, 5, "Splitting…");

      try {
        const srcDoc = await PDFLib.PDFDocument.load(pdfBytes);
        const base = safeBaseName(file.name);
        const total = finalGroups.length;

        for (let i = 0; i < total; i++) {
          const g = finalGroups[i];
          setProgress(row, bar, pct, lbl, true, ((i + 0.5) / total) * 100, `Part ${i + 1} of ${total}…`);
          const out = await PDFLib.PDFDocument.create();
          const idx = g.map((p) => p - 1);
          const copied = await out.copyPages(srcDoc, idx);
          copied.forEach((p) => out.addPage(p));
          const outBytes = await out.save();
          const name =
            g.length === 1
              ? `${base}_p${String(g[0]).padStart(2, "0")}.pdf`
              : `${base}_p${String(g[0]).padStart(2, "0")}-${String(g[g.length - 1]).padStart(2, "0")}.pdf`;
          const outBlob = new Blob([outBytes], { type: "application/pdf" });
          downloadBlob(outBlob, name);
        }
        setProgress(row, bar, pct, lbl, true, 100, "Done");
        setTimeout(() => setProgress(row, bar, pct, lbl, false, 0, ""), 700);
      } catch (e) {
        preview.innerHTML = `<span class="muted">Error: ${escapeHtml(e.message || e)}</span>`;
        setProgress(row, bar, pct, lbl, false, 0, "");
      } finally {
        btn.disabled = false;
        clear.disabled = false;
      }
    });

    clear.addEventListener("click", reset);
  }

  // --- Merge ---
  function initMerge() {
    const input = $("#mergeInput");
    const list = $("#mergeList");
    const btn = $("#mergeBtn");
    const clear = $("#mergeClear");
    const meta = $("#mergeFileMeta");
    const row = $("#mergeProg");
    const bar = $("#mergeProgBar");
    const pct = $("#mergeProgPct");
    const lbl = $("#mergeProgLbl");

    let items = [];

    function render() {
      list.innerHTML = "";
      for (const it of items) {
        const div = document.createElement("div");
        div.className = "fileitem";
        div.draggable = true;
        div.dataset.id = it.id;
        div.innerHTML = `
          <span class="fileitem__name" title="${escapeAttr(it.file.name)}">${escapeHtml(it.file.name)}</span>
          <span class="muted">${formatBytes(it.file.size)}</span>
          <button type="button" class="btn btn--secondary" data-rm="${it.id}" style="padding:4px 8px;min-height:32px;font-size:11px">✕</button>`;
        list.appendChild(div);
      }
    }

    function sync() {
      showFilesMeta(meta, items.map((x) => x.file));
      btn.disabled = items.length < 2;
      clear.disabled = items.length === 0;
      if (!items.length) list.innerHTML = "";
      else render();
    }

    list.addEventListener("click", (e) => {
      const id = e.target.closest("[data-rm]")?.dataset?.rm;
      if (!id) return;
      items = items.filter((x) => x.id !== id);
      sync();
    });

    makeReorderable(
      list,
      () => items,
      (next) => (items = next),
      () => {
        render();
        sync();
      },
    );

    input.addEventListener("change", async () => {
      const files = getInputFiles(input).filter(
        (f) => f.type === "application/pdf" || f.name.toLowerCase().endsWith(".pdf"),
      );
      for (const f of files) {
        items.push({ id: uid(), file: f, bytes: await bytesFromFile(f) });
      }
      sync();
    });

    btn.addEventListener("click", async () => {
      if (items.length < 2) return;
      ensurePdfLib();
      btn.disabled = true;
      clear.disabled = true;
      setProgress(row, bar, pct, lbl, true, 4, "Merging…");
      try {
        const out = await PDFLib.PDFDocument.create();
        for (let i = 0; i < items.length; i++) {
          setProgress(row, bar, pct, lbl, true, ((i + 0.5) / items.length) * 100, `PDF ${i + 1} of ${items.length}…`);
          const src = await PDFLib.PDFDocument.load(items[i].bytes);
          const copied = await out.copyPages(src, src.getPageIndices());
          copied.forEach((p) => out.addPage(p));
        }
        const bytes = await out.save();
        const blob = blobFromBytes(bytes, "application/pdf");
        const name = `merged_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.pdf`;
        downloadBlob(blob, name);
        setProgress(row, bar, pct, lbl, true, 100, "Done");
        setTimeout(() => setProgress(row, bar, pct, lbl, false, 0, ""), 600);
      } catch (e) {
        alert(`Merge failed: ${e.message || e}`);
        setProgress(row, bar, pct, lbl, false, 0, "");
      } finally {
        btn.disabled = items.length < 2;
        clear.disabled = items.length === 0;
      }
    });

    clear.addEventListener("click", () => {
      items = [];
      input.value = "";
      sync();
    });
  }

  // --- PNG → PDF ---
  function initPng2Pdf() {
    const input = $("#png2pdfInput");
    const list = $("#png2pdfList");
    const btn = $("#png2pdfBtn");
    const clear = $("#png2pdfClear");
    const meta = $("#png2pdfFileMeta");
    const row = $("#png2pdfProg");
    const bar = $("#png2pdfProgBar");
    const pct = $("#png2pdfProgPct");
    const lbl = $("#png2pdfProgLbl");

    let items = [];

    function render() {
      list.innerHTML = "";
      for (const it of items) {
        const div = document.createElement("div");
        div.className = "fileitem";
        div.draggable = true;
        div.dataset.id = it.id;
        div.innerHTML = `
          <span class="fileitem__name" title="${escapeAttr(it.file.name)}">${escapeHtml(it.file.name)}</span>
          <span class="muted">${formatBytes(it.file.size)}</span>
          <button type="button" class="btn btn--secondary" data-rm="${it.id}" style="padding:4px 8px;min-height:32px;font-size:11px">✕</button>`;
        list.appendChild(div);
      }
    }

    function sync() {
      showFilesMeta(meta, items.map((x) => x.file));
      btn.disabled = !items.length;
      clear.disabled = !items.length;
      if (!items.length) list.innerHTML = "";
      else render();
    }

    list.addEventListener("click", (e) => {
      const id = e.target.closest("[data-rm]")?.dataset?.rm;
      if (!id) return;
      items = items.filter((x) => x.id !== id);
      sync();
    });

    makeReorderable(
      list,
      () => items,
      (next) => (items = next),
      () => {
        render();
        sync();
      },
    );

    input.addEventListener("change", async () => {
      const files = getInputFiles(input).filter(
        (f) =>
          f.type === "image/png" ||
          f.type === "image/jpeg" ||
          f.name.toLowerCase().endsWith(".png") ||
          f.name.toLowerCase().endsWith(".jpg") ||
          f.name.toLowerCase().endsWith(".jpeg"),
      );
      for (const f of files) {
        const bytes = await bytesFromFile(f);
        items.push({ id: uid(), file: f, bytes });
      }
      sync();
    });

    btn.addEventListener("click", async () => {
      if (!items.length) return;
      ensurePdfLib();
      btn.disabled = true;
      clear.disabled = true;
      setProgress(row, bar, pct, lbl, true, 6, "Building PDF…");
      try {
        const pdfDoc = await PDFLib.PDFDocument.create();
        for (let i = 0; i < items.length; i++) {
          setProgress(row, bar, pct, lbl, true, ((i + 0.5) / items.length) * 100, `Image ${i + 1} of ${items.length}…`);
          const lower = items[i].file.name.toLowerCase();
          const isPng = items[i].file.type === "image/png" || lower.endsWith(".png");
          const img = isPng ? await pdfDoc.embedPng(items[i].bytes) : await pdfDoc.embedJpg(items[i].bytes);
          const { width, height } = img.scale(1);
          const page = pdfDoc.addPage([width, height]);
          page.drawImage(img, { x: 0, y: 0, width, height });
        }
        const bytes = await pdfDoc.save();
        const blob = blobFromBytes(bytes, "application/pdf");
        const name = `images_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.pdf`;
        downloadBlob(blob, name);
        setProgress(row, bar, pct, lbl, true, 100, "Done");
        setTimeout(() => setProgress(row, bar, pct, lbl, false, 0, ""), 600);
      } catch (e) {
        alert(`PNG→PDF failed: ${e.message || e}`);
        setProgress(row, bar, pct, lbl, false, 0, "");
      } finally {
        btn.disabled = !items.length;
        clear.disabled = !items.length;
      }
    });

    clear.addEventListener("click", () => {
      items = [];
      input.value = "";
      sync();
    });
  }

  // --- PDF → PNG ---
  function initPdf2Png() {
    const input = $("#pdf2pngInput");
    const btn = $("#pdf2pngBtn");
    const clear = $("#pdf2pngClear");
    const meta = $("#pdf2pngFileMeta");
    const preview = $("#pdf2pngPreview");
    const row = $("#pdf2pngProg");
    const bar = $("#pdf2pngProgBar");
    const pct = $("#pdf2pngProgPct");
    const lbl = $("#pdf2pngProgLbl");

    let pdfBytes = null;
    let file = null;

    function reset() {
      pdfBytes = null;
      file = null;
      input.value = "";
      btn.disabled = true;
      clear.disabled = true;
      meta.hidden = true;
      preview.innerHTML = `<span class="muted">Thumbnails after conversion.</span>`;
      setProgress(row, bar, pct, lbl, false, 0, "");
    }

    input.addEventListener("change", async () => {
      const f = getInputFiles(input)[0];
      if (!f) return;
      pdfBytes = await bytesFromFile(f);
      file = f;
      showFileMeta(meta, file);
      btn.disabled = false;
      clear.disabled = false;
    });

    btn.addEventListener("click", async () => {
      if (!pdfBytes || !file) return;
      btn.disabled = true;
      clear.disabled = true;
      setProgress(row, bar, pct, lbl, true, 2, "Loading PDF…");
      try {
        const pdfDoc = await loadPdfJsDocument(pdfBytes);
        const n = pdfDoc.numPages;
        const base = safeBaseName(file.name);
        preview.innerHTML = "";
        const thumbsWrap = document.createElement("div");
        thumbsWrap.className = "thumbs";

        for (let p = 1; p <= n; p++) {
          setProgress(row, bar, pct, lbl, true, ((p - 0.5) / n) * 100, `Page ${p} of ${n}…`);
          const canvas = await renderPageToCanvas(pdfDoc, p, 2);
          const blob = await canvasToBlob(canvas, "image/png");
          const name = `${base}_page_${String(p).padStart(2, "0")}.png`;
          downloadBlob(blob, name);

          if (p <= 6) {
            const url = URL.createObjectURL(blob);
            const img = document.createElement("img");
            img.src = url;
            img.alt = `Page ${p}`;
            const wrap = document.createElement("div");
            wrap.className = "thumb";
            wrap.appendChild(img);
            thumbsWrap.appendChild(wrap);
          }
        }
        if (thumbsWrap.childElementCount) preview.appendChild(thumbsWrap);
        setProgress(row, bar, pct, lbl, true, 100, "Done");
        setTimeout(() => setProgress(row, bar, pct, lbl, false, 0, ""), 600);
      } catch (e) {
        preview.innerHTML = `<span class="muted">Error: ${escapeHtml(e.message || e)}</span>`;
        setProgress(row, bar, pct, lbl, false, 0, "");
      } finally {
        btn.disabled = false;
        clear.disabled = false;
      }
    });

    clear.addEventListener("click", reset);
  }

  // --- Compress ---
  function initCompress() {
    const input = $("#compressInput");
    const qRange = $("#compressQuality");
    const qLbl = $("#compressQualityLbl");
    const btn = $("#compressBtn");
    const clear = $("#compressClear");
    const meta = $("#compressFileMeta");
    const row = $("#compressProg");
    const bar = $("#compressProgBar");
    const pct = $("#compressProgPct");
    const lbl = $("#compressProgLbl");

    let pdfBytes = null;
    let file = null;

    function reset() {
      pdfBytes = null;
      file = null;
      input.value = "";
      btn.disabled = true;
      clear.disabled = true;
      meta.hidden = true;
      setProgress(row, bar, pct, lbl, false, 0, "");
    }

    qRange.addEventListener("input", () => {
      qLbl.textContent = `${Math.round(parseFloat(qRange.value) * 100)}%`;
    });
    qLbl.textContent = `${Math.round(parseFloat(qRange.value) * 100)}%`;

    input.addEventListener("change", async () => {
      const f = getInputFiles(input)[0];
      if (!f) return;
      pdfBytes = await bytesFromFile(f);
      file = f;
      showFileMeta(meta, file);
      btn.disabled = false;
      clear.disabled = false;
    });

    btn.addEventListener("click", async () => {
      if (!pdfBytes || !file) return;
      ensurePdfJs();
      ensurePdfLib();
      const quality = parseFloat(qRange.value);
      btn.disabled = true;
      clear.disabled = true;
      setProgress(row, bar, pct, lbl, true, 3, "Compressing…");

      try {
        const pdfJsDoc = await loadPdfJsDocument(pdfBytes);
        const n = pdfJsDoc.numPages;
        const outPdf = await PDFLib.PDFDocument.create();

        for (let p = 1; p <= n; p++) {
          setProgress(row, bar, pct, lbl, true, ((p - 0.5) / n) * 100, `Page ${p} of ${n}…`);
          const canvas = await renderPageToCanvas(pdfJsDoc, p, 1.35);
          const jpegBlob = await canvasToBlob(canvas, "image/jpeg", quality);
          const jpegBytes = new Uint8Array(await jpegBlob.arrayBuffer());
          const jpg = await outPdf.embedJpg(jpegBytes);
          const page = outPdf.addPage([jpg.width, jpg.height]);
          page.drawImage(jpg, { x: 0, y: 0, width: jpg.width, height: jpg.height });
        }

        const bytes = await outPdf.save({ useObjectStreams: true });
        const blob = blobFromBytes(bytes, "application/pdf");
        const name = `${safeBaseName(file.name)}_compressed.pdf`;
        downloadBlob(blob, name);
        setProgress(row, bar, pct, lbl, true, 100, "Done");
        setTimeout(() => setProgress(row, bar, pct, lbl, false, 0, ""), 600);
      } catch (e) {
        alert(`Compress failed: ${e.message || e}`);
        setProgress(row, bar, pct, lbl, false, 0, "");
      } finally {
        btn.disabled = false;
        clear.disabled = false;
      }
    });

    clear.addEventListener("click", reset);
  }

  // --- Rotate ---
  function initRotate() {
    const input = $("#rotateInput");
    const angleSel = $("#rotateAngle");
    const btn = $("#rotateBtn");
    const clear = $("#rotateClear");
    const meta = $("#rotateFileMeta");
    const row = $("#rotateProg");
    const bar = $("#rotateProgBar");
    const pct = $("#rotateProgPct");
    const lbl = $("#rotateProgLbl");

    let pdfBytes = null;
    let file = null;

    function reset() {
      pdfBytes = null;
      file = null;
      input.value = "";
      btn.disabled = true;
      clear.disabled = true;
      meta.hidden = true;
      setProgress(row, bar, pct, lbl, false, 0, "");
    }

    input.addEventListener("change", async () => {
      const f = getInputFiles(input)[0];
      if (!f) return;
      pdfBytes = await bytesFromFile(f);
      file = f;
      showFileMeta(meta, file);
      btn.disabled = false;
      clear.disabled = false;
    });

    btn.addEventListener("click", async () => {
      if (!pdfBytes || !file) return;
      ensurePdfLib();
      const { PDFDocument, degrees } = PDFLib;
      const add = parseInt(angleSel.value, 10);
      btn.disabled = true;
      clear.disabled = true;
      setProgress(row, bar, pct, lbl, true, 10, "Rotating…");
      try {
        const doc = await PDFDocument.load(pdfBytes);
        const pages = doc.getPages();
        for (let i = 0; i < pages.length; i++) {
          setProgress(row, bar, pct, lbl, true, ((i + 0.5) / pages.length) * 100, `Page ${i + 1} of ${pages.length}…`);
          const page = pages[i];
          const rot = page.getRotation();
          const cur = typeof rot.angle === "number" ? rot.angle : 0;
          page.setRotation(degrees(cur + add));
        }
        const bytes = await doc.save();
        const blob = blobFromBytes(bytes, "application/pdf");
        downloadBlob(blob, `${safeBaseName(file.name)}_rotated.pdf`);
        setProgress(row, bar, pct, lbl, true, 100, "Done");
        setTimeout(() => setProgress(row, bar, pct, lbl, false, 0, ""), 600);
      } catch (e) {
        alert(`Rotate failed: ${e.message || e}`);
        setProgress(row, bar, pct, lbl, false, 0, "");
      } finally {
        btn.disabled = false;
        clear.disabled = false;
      }
    });

    clear.addEventListener("click", reset);
  }

  // --- Extract ---
  function initExtract() {
    const input = $("#extractInput");
    const pagesIn = $("#extractPages");
    const btn = $("#extractBtn");
    const clear = $("#extractClear");
    const meta = $("#extractFileMeta");
    const row = $("#extractProg");
    const bar = $("#extractProgBar");
    const pct = $("#extractProgPct");
    const lbl = $("#extractProgLbl");

    let pdfBytes = null;
    let file = null;
    let pageCount = 0;

    function reset() {
      pdfBytes = null;
      file = null;
      pageCount = 0;
      input.value = "";
      pagesIn.value = "";
      btn.disabled = true;
      clear.disabled = true;
      meta.hidden = true;
      setProgress(row, bar, pct, lbl, false, 0, "");
    }

    input.addEventListener("change", async () => {
      const f = getInputFiles(input)[0];
      if (!f) return;
      try {
        ensurePdfLib();
        pdfBytes = await bytesFromFile(f);
        file = f;
        const doc = await PDFLib.PDFDocument.load(pdfBytes);
        pageCount = doc.getPageCount();
        showFileMeta(meta, file);
        btn.disabled = false;
        clear.disabled = false;
      } catch (e) {
        alert(e.message || e);
        reset();
      }
    });

    btn.addEventListener("click", async () => {
      if (!pdfBytes || !file) return;
      const indices = parsePageIndices(pagesIn.value, pageCount);
      if (!indices.length) {
        alert("Enter at least one valid page number.");
        return;
      }
      ensurePdfLib();
      btn.disabled = true;
      clear.disabled = true;
      setProgress(row, bar, pct, lbl, true, 20, "Extracting…");
      try {
        const src = await PDFLib.PDFDocument.load(pdfBytes);
        const out = await PDFLib.PDFDocument.create();
        const zeroBased = indices.map((p) => p - 1);
        const copied = await out.copyPages(src, zeroBased);
        copied.forEach((p) => out.addPage(p));
        const bytes = await out.save();
        const blob = blobFromBytes(bytes, "application/pdf");
        const name = `${safeBaseName(file.name)}_extract.pdf`;
        downloadBlob(blob, name);
        setProgress(row, bar, pct, lbl, true, 100, "Done");
        setTimeout(() => setProgress(row, bar, pct, lbl, false, 0, ""), 600);
      } catch (e) {
        alert(`Extract failed: ${e.message || e}`);
        setProgress(row, bar, pct, lbl, false, 0, "");
      } finally {
        btn.disabled = false;
        clear.disabled = false;
      }
    });

    clear.addEventListener("click", reset);
  }

  window.addEventListener("DOMContentLoaded", () => {
    try {
      ensurePdfLib();
    } catch (e) {
      document.querySelector(".tools-grid").innerHTML = `<section class="tool"><p>${escapeHtml(
        e.message || String(e),
      )}</p><p class="muted">Check your network connection (CDN scripts).</p></section>`;
      return;
    }

    initTheme();
    initDropzones();
    initNavScrollSpy();
    initSplit();
    initMerge();
    initPng2Pdf();
    initPdf2Png();
    initCompress();
    initRotate();
    initExtract();
  });
})();
