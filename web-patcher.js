(function () {
  'use strict';
  var drop = document.getElementById('drop');
  var dropText = document.getElementById('drop-text');
  var fileInput = document.getElementById('file');
  var patchBtn = document.getElementById('patchBtn');
  var statusEl = document.getElementById('status');
  var chosen = null;

  // Drag & Drop ვიზუალური ეფექტები
  drop.addEventListener('dragover', function (e) {
    e.preventDefault();
    drop.classList.add('drag-over');
    dropText.textContent = 'DROP FILE HERE TO PATCH';
  });

  drop.addEventListener('dragleave', function () {
    drop.classList.remove('drag-over');
    dropText.textContent = 'Drop your video here';
  });

  drop.addEventListener('drop', function (e) {
    e.preventDefault();
    drop.classList.remove('drag-over');
    var files = e.dataTransfer.files;
    if (files.length > 0) choose(files[0]);
  });

  function choose(f) {
    if (!f) return;
    if (!/\.mp4$/i.test(f.name)) {
      statusEl.textContent = 'ERROR: ONLY .MP4 FILES';
      return;
    }
    chosen = f;
    patchBtn.disabled = false;
    dropText.textContent = 'SELECTED: ' + f.name;
    statusEl.textContent = 'READY TO PATCH';
  }

  drop.addEventListener('click', function () { fileInput.click(); });
  fileInput.addEventListener('change', function () { choose(fileInput.files[0]); });

  patchBtn.addEventListener('click', function () {
    if (!chosen) return;
    patchBtn.disabled = true;
    statusEl.textContent = 'PATCHING... PLEASE WAIT';
    
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var input = new Uint8Array(reader.result);
        var res = MoonPatcher.patch(input);
        var blob = new Blob([res.buffer], { type: 'video/mp4' });
        var url = URL.createObjectURL(blob);
        
        var a = document.createElement('a');
        a.href = url;
        a.download = 'moon-' + chosen.name;
        document.body.appendChild(a);
        a.click();
        a.remove();
        
        statusEl.textContent = 'DONE. VIDEO SAVED.';
        dropText.textContent = 'Drop another video';
      } catch (err) {
        statusEl.textContent = 'ERROR: ' + err.message;
      } finally {
        patchBtn.disabled = false;
      }
    };
    reader.readAsArrayBuffer(chosen);
  });
})();