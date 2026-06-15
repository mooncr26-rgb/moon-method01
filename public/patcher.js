/*
 * Moon patcher — standalone browser port of the site's `pad` mode.
 *
 * No dependencies, no build step. Mirrors src/lib/patcher.ts `patchPad`
 * exactly: inflate the video frame COUNT to 10× by appending zero-byte filler
 * frames (one shared 8-byte NAL), keeping every per-sample table consistent
 * and the real duration / codec untouched. Works on H.264 and H.265.
 *
 * Exposes MoonPatcher.patch(Uint8Array) -> { buffer, realFrames, totalFrames }.
 */
(function (root) {
  'use strict';

  var PAD_FRAME_MULTIPLIER = 10;
  var PAD_FILLER_NAL = new Uint8Array([0, 0, 0, 4, 0, 0, 0, 0]); // 4-byte length + NAL type 0
  var PAD_SDTP_BYTE = 0x10;

  // ---- byte helpers (big-endian) ----
  function u32(b, o) { return b[o] * 0x1000000 + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3]; }
  function setU32(b, o, v) { b[o] = (v >>> 24) & 0xff; b[o + 1] = (v >>> 16) & 0xff; b[o + 2] = (v >>> 8) & 0xff; b[o + 3] = v & 0xff; }
  function u64(b, o) { return u32(b, o) * 0x100000000 + u32(b, o + 4); }
  function str4(b, o) { return String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]); }
  function concat(list) {
    var len = 0, i;
    for (i = 0; i < list.length; i++) len += list[i].length;
    var out = new Uint8Array(len), off = 0;
    for (i = 0; i < list.length; i++) { out.set(list[i], off); off += list[i].length; }
    return out;
  }

  function readAtom(b, off, end) {
    var size = u32(b, off);
    var type = str4(b, off + 4);
    var header = 8;
    if (size === 1) { size = u64(b, off + 8); header = 16; }
    else if (size === 0) size = end - off;
    return { type: type, start: off, header: header, payloadStart: off + header, payloadEnd: off + size };
  }
  function findTopLevel(b, type) {
    var off = 0;
    while (off + 8 <= b.length) {
      var a = readAtom(b, off, b.length);
      if (a.type === type) return a;
      if (a.payloadEnd <= a.start) break;
      off = a.payloadEnd;
    }
    return null;
  }

  // ---- editable atom tree (mirrors parseAtomTree / serializeAtom) ----
  var PURE = { moov: 1, trak: 1, mdia: 1, minf: 1, stbl: 1, dinf: 1, edts: 1, udta: 1, mvex: 1, moof: 1, traf: 1, ilst: 1 };
  var FULLBOX = { meta: 1 };

  function parseTree(b, start, end, parentType) {
    var out = [], off = start;
    while (off + 8 <= end) {
      var a = readAtom(b, off, end);
      if (a.payloadEnd > end || a.payloadEnd <= a.start) break;
      if (FULLBOX[a.type]) {
        out.push({ type: a.type, payload: b.slice(a.payloadStart, a.payloadStart + 4), children: parseTree(b, a.payloadStart + 4, a.payloadEnd, a.type) });
      } else if (PURE[a.type] || parentType === 'ilst') {
        out.push({ type: a.type, payload: null, children: parseTree(b, a.payloadStart, a.payloadEnd, a.type) });
      } else {
        out.push({ type: a.type, payload: b.slice(a.payloadStart, a.payloadEnd), children: null });
      }
      off = a.payloadEnd;
    }
    return out;
  }
  function serialize(node) {
    var parts = [];
    if (node.payload) parts.push(node.payload);
    if (node.children) for (var i = 0; i < node.children.length; i++) parts.push(serialize(node.children[i]));
    var body = concat(parts);
    var out = new Uint8Array(8 + body.length);
    setU32(out, 0, out.length);
    out[4] = node.type.charCodeAt(0) & 0xff; out[5] = node.type.charCodeAt(1) & 0xff;
    out[6] = node.type.charCodeAt(2) & 0xff; out[7] = node.type.charCodeAt(3) & 0xff;
    out.set(body, 8);
    return out;
  }
  function findChild(node, type) {
    if (!node || !node.children) return null;
    for (var i = 0; i < node.children.length; i++) if (node.children[i].type === type) return node.children[i];
    return null;
  }

  function findVideoStbl(moov) {
    var traks = moov.children || [];
    for (var i = 0; i < traks.length; i++) {
      var trak = traks[i];
      if (trak.type !== 'trak') continue;
      var mdia = findChild(trak, 'mdia');
      var hdlr = findChild(mdia, 'hdlr');
      if (!hdlr || !hdlr.payload) continue;
      if (str4(hdlr.payload, 8) !== 'vide') continue; // handler_type at payload+8
      var minf = findChild(mdia, 'minf');
      var stbl = findChild(minf, 'stbl');
      if (!stbl) continue;
      var stsz = findChild(stbl, 'stsz'), stts = findChild(stbl, 'stts'), stsc = findChild(stbl, 'stsc');
      var stco = findChild(stbl, 'stco'), co64 = findChild(stbl, 'co64');
      var chunkBox = stco || co64;
      if (!stsz || !stts || !stsc || !chunkBox) continue;
      return { stsz: stsz, stts: stts, stsc: stsc, chunkBox: chunkBox, is64: !!co64, sdtp: findChild(stbl, 'sdtp'), ctts: findChild(stbl, 'ctts') };
    }
    return null;
  }

  // Inflate the video frame count to 10× by appending M filler samples, keeping
  // every per-sample table consistent. fillerOff = filler position in SOURCE
  // coords (= srcMdat.payloadEnd); the chunk-offset shift relocates it later.
  function inflate(moov, fillerOff) {
    var n = findVideoStbl(moov);
    if (!n) throw new Error('No video track found.');

    var sttsEntries = u32(n.stts.payload, 4);
    if (sttsEntries === 0) throw new Error('Video stts is empty.');
    var realFrames = 0, i;
    for (i = 0; i < sttsEntries; i++) realFrames += u32(n.stts.payload, 8 + i * 8);

    var total = realFrames * PAD_FRAME_MULTIPLIER;
    var M = total - realFrames;
    if (M <= 0) return { realFrames: realFrames, totalFrames: realFrames };

    // stsz: append M entries of size 8 (table form)
    var constSize = u32(n.stsz.payload, 4);
    var oldCount = u32(n.stsz.payload, 8);
    if (constSize === 0) {
      var extra = new Uint8Array(M * 4);
      for (i = 0; i < M; i++) setU32(extra, i * 4, 8);
      n.stsz.payload = concat([n.stsz.payload, extra]);
      setU32(n.stsz.payload, 8, oldCount + M);
    } else {
      var head = n.stsz.payload.slice(0, 12);
      setU32(head, 4, 0); setU32(head, 8, oldCount + M);
      var table = new Uint8Array((oldCount + M) * 4);
      for (i = 0; i < oldCount; i++) setU32(table, i * 4, constSize);
      for (i = 0; i < M; i++) setU32(table, (oldCount + i) * 4, 8);
      n.stsz.payload = concat([head, table]);
    }

    // stts: extend the last entry's COUNT by M (keeps a single clean run)
    var lastOff = 8 + (sttsEntries - 1) * 8;
    setU32(n.stts.payload, lastOff, u32(n.stts.payload, lastOff) + M);

    // sdtp: append M dependency bytes so it still covers every sample
    if (n.sdtp && n.sdtp.payload) {
      var sd = new Uint8Array(M); sd.fill(PAD_SDTP_BYTE);
      n.sdtp.payload = concat([n.sdtp.payload, sd]);
    }

    // ctts: append one entry (M, 0) so it still covers every sample
    if (n.ctts && n.ctts.payload) {
      var ce = u32(n.ctts.payload, 4);
      var ent = new Uint8Array(8); setU32(ent, 0, M); setU32(ent, 4, 0);
      n.ctts.payload = concat([n.ctts.payload, ent]);
      setU32(n.ctts.payload, 4, ce + 1);
    }

    // chunk offsets: append M entries all pointing at the single filler NAL
    var chunkCount = u32(n.chunkBox.payload, 4);
    if (n.is64) {
      var ex64 = new Uint8Array(M * 8);
      for (i = 0; i < M; i++) { setU32(ex64, i * 8, Math.floor(fillerOff / 0x100000000)); setU32(ex64, i * 8 + 4, fillerOff >>> 0); }
      n.chunkBox.payload = concat([n.chunkBox.payload, ex64]);
    } else {
      var ex32 = new Uint8Array(M * 4);
      for (i = 0; i < M; i++) setU32(ex32, i * 4, fillerOff);
      n.chunkBox.payload = concat([n.chunkBox.payload, ex32]);
    }
    setU32(n.chunkBox.payload, 4, chunkCount + M);

    // stsc: append one run so each dummy chunk holds exactly 1 sample
    var stscCount = u32(n.stsc.payload, 4);
    var run = new Uint8Array(12);
    setU32(run, 0, chunkCount + 1); setU32(run, 4, 1); setU32(run, 8, 1);
    n.stsc.payload = concat([n.stsc.payload, run]);
    setU32(n.stsc.payload, 4, stscCount + 1);

    return { realFrames: realFrames, totalFrames: total };
  }

  // Shift every stco/co64 offset in the serialized moov by `shift`.
  function shiftChunkOffsets(moovBuf, shift) {
    function walk(start, end) {
      var off = start;
      while (off + 8 <= end) {
        var size = u32(moovBuf, off);
        var type = str4(moovBuf, off + 4);
        if (size < 8 || off + size > end) return;
        var header = size === 1 ? 16 : 8;
        var ps = off + header;
        if (type === 'stco') {
          var c = u32(moovBuf, ps + 4);
          for (var i = 0; i < c; i++) { var eo = ps + 8 + i * 4; setU32(moovBuf, eo, u32(moovBuf, eo) + shift); }
        } else if (type === 'co64') {
          var c2 = u32(moovBuf, ps + 4);
          for (var j = 0; j < c2; j++) { var eo2 = ps + 8 + j * 8; var v = u64(moovBuf, eo2) + shift; setU32(moovBuf, eo2, Math.floor(v / 0x100000000)); setU32(moovBuf, eo2 + 4, v >>> 0); }
        }
        if (PURE[type]) walk(ps, off + size);
        else if (FULLBOX[type]) walk(ps + 4, off + size);
        off += size;
      }
    }
    walk(0, moovBuf.length);
  }

  function patch(input) {
    var buf = input instanceof Uint8Array ? input : new Uint8Array(input);
    var ftyp = findTopLevel(buf, 'ftyp');
    var moovLoc = findTopLevel(buf, 'moov');
    var mdat = findTopLevel(buf, 'mdat');
    if (!ftyp || !moovLoc || !mdat) throw new Error('Not a valid MP4 (missing ftyp/moov/mdat).');

    var moov = parseTree(buf, moovLoc.start, moovLoc.payloadEnd, null)[0];
    if (!moov || moov.type !== 'moov') throw new Error('Could not parse moov.');

    var stats = inflate(moov, mdat.payloadEnd); // filler sits at end of source mdat payload

    var newMoov = serialize(moov);

    var ftypBytes = buf.slice(ftyp.start, ftyp.payloadEnd); // keep source ftyp verbatim
    var freeBox = new Uint8Array([0, 0, 0, 8, 0x66, 0x72, 0x65, 0x65]); // 'free', size 8
    var newMdatOffset = ftypBytes.length + newMoov.length + freeBox.length;
    var shift = newMdatOffset - mdat.start;
    shiftChunkOffsets(newMoov, shift);

    // Rebuild mdat header (keep source header width) with the filler appended.
    var mdatHeaderSize = mdat.payloadStart - mdat.start;
    var origPayloadLen = mdat.payloadEnd - mdat.payloadStart;
    var newPayloadLen = origPayloadLen + PAD_FILLER_NAL.length;
    var newAtomSize = mdatHeaderSize + newPayloadLen;
    var mdatHeader = new Uint8Array(mdatHeaderSize);
    if (mdatHeaderSize === 8) {
      setU32(mdatHeader, 0, newAtomSize);
      mdatHeader[4] = 0x6d; mdatHeader[5] = 0x64; mdatHeader[6] = 0x61; mdatHeader[7] = 0x74;
    } else {
      setU32(mdatHeader, 0, 1);
      mdatHeader[4] = 0x6d; mdatHeader[5] = 0x64; mdatHeader[6] = 0x61; mdatHeader[7] = 0x74;
      setU32(mdatHeader, 8, Math.floor(newAtomSize / 0x100000000));
      setU32(mdatHeader, 12, newAtomSize >>> 0);
    }

    var out = concat([
      ftypBytes,
      newMoov,
      freeBox,
      mdatHeader,
      buf.slice(mdat.payloadStart, mdat.payloadEnd),
      PAD_FILLER_NAL,
    ]);

    return { buffer: out, realFrames: stats.realFrames, totalFrames: stats.totalFrames };
  }

  var api = { patch: patch };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MoonPatcher = api;
})(typeof self !== 'undefined' ? self : this);