// A deliberately small Markdown renderer for the catalog's text: paragraphs, lists, tables,
// fenced code, inline code, bold, italic and links. Everything is escaped before formatting,
// and links may only point at #/ routes, relative files or http(s) URLs.
(function (KA) {
  "use strict";
  var esc = function (s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  };

  function safeHref(raw) {
    var url = raw.replace(/&amp;/g, "&").trim();
    if (/^(https?:\/\/|#\/|\.{0,2}\/?[\w.-]+(\/[\w.#-]*)*$)/i.test(url) && !/^\s*(javascript|data|vbscript):/i.test(url)) {
      return esc(url);
    }
    return null;
  }

  function inline(src) {
    var codes = [];
    var s = esc(src).replace(/`([^`]+)`/g, function (_, c) { codes.push(c); return "\u0000" + (codes.length - 1) + "\u0000"; });
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, function (m, label, href) {
      var h = safeHref(href);
      if (!h) return label;
      var ext = /^https?:/i.test(h) ? ' rel="noopener" target="_blank"' : "";
      return '<a href="' + h + '"' + ext + ">" + label + "</a>";
    });
    s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/(^|[\s(])\*([^*\s][^*]*)\*(?=[\s).,;:!?]|$)/g, "$1<em>$2</em>");
    // "see oomkilled" becomes a link when the id exists in the catalog
    if (KA.idx && KA.idx.failure) {
      s = s.replace(/\bsee ([a-z0-9]+(?:-[a-z0-9]+)+|oomkilled|crashloopbackoff|imagepullbackoff)\b/g, function (m, id) {
        return KA.idx.failure(id) ? 'see <a href="#/failures/' + id + '">' + id + "</a>" : m;
      });
    }
    return s.replace(/\u0000(\d+)\u0000/g, function (_, i) { return "<code>" + codes[+i] + "</code>"; });
  }

  function codeBlock(code, lang) {
    return '<div class="code"><pre><code' + (lang ? ' data-lang="' + esc(lang) + '"' : "") + ">" + esc(code) +
      '</code></pre><button type="button" class="copy" data-copy>Copy</button></div>';
  }

  function table(rows) {
    var cells = rows.map(function (r) {
      return r.trim().replace(/^\||\|$/g, "").split("|").map(function (c) { return c.trim(); });
    });
    var head = cells[0];
    var body = cells.slice(2);
    var out = '<div class="table-wrap"><table><thead><tr>' +
      head.map(function (c) { return "<th>" + inline(c) + "</th>"; }).join("") + "</tr></thead><tbody>";
    body.forEach(function (r) { out += "<tr>" + r.map(function (c) { return "<td>" + inline(c) + "</td>"; }).join("") + "</tr>"; });
    return out + "</tbody></table></div>";
  }

  function render(src) {
    var lines = KA.text(src).replace(/\r/g, "").split("\n");
    var out = [];
    var i = 0;
    while (i < lines.length) {
      var ln = lines[i];
      var fence = ln.match(/^\s*```\s*([\w-]*)/);
      if (fence) {
        var indent = ln.match(/^\s*/)[0].length;
        var buf = [];
        i++;
        while (i < lines.length && !/^\s*```/.test(lines[i])) { buf.push(lines[i].slice(Math.min(indent, lines[i].match(/^\s*/)[0].length))); i++; }
        out.push(codeBlock(buf.join("\n"), fence[1]));
        i++;
        continue;
      }
      if (/^\s*\|/.test(ln) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
        var rows = [];
        while (i < lines.length && /^\s*\|/.test(lines[i])) { rows.push(lines[i]); i++; }
        out.push(table(rows));
        continue;
      }
      var li = ln.match(/^(\s*)([-*]|\d+\.)\s+(.*)/);
      if (li) {
        var ordered = /\d/.test(li[2]);
        var items = [];
        while (i < lines.length) {
          var m = lines[i].match(/^(\s*)([-*]|\d+\.)\s+(.*)/);
          if (m && (/\d/.test(m[2]) === ordered)) { items.push([m[3]]); i++; continue; }
          if (items.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*```/.test(lines[i])) { items[items.length - 1].push(lines[i].trim()); i++; continue; }
          if (items.length && /^\s*```/.test(lines[i])) {
            var ind = lines[i].match(/^\s*/)[0].length, b = [];
            i++;
            while (i < lines.length && !/^\s*```/.test(lines[i])) { b.push(lines[i].slice(Math.min(ind, lines[i].match(/^\s*/)[0].length))); i++; }
            i++;
            items[items.length - 1].push({ code: b.join("\n") });
            continue;
          }
          break;
        }
        var tag = ordered ? "ol" : "ul";
        out.push("<" + tag + ">" + items.map(function (parts) {
          var text = parts.filter(function (p) { return typeof p === "string"; }).join(" ");
          var code = parts.filter(function (p) { return typeof p !== "string"; }).map(function (p) { return codeBlock(p.code); }).join("");
          return "<li>" + inline(text) + code + "</li>";
        }).join("") + "</" + tag + ">");
        continue;
      }
      if (!ln.trim()) { i++; continue; }
      var para = [];
      while (i < lines.length && lines[i].trim() && !/^\s*```/.test(lines[i]) && !/^(\s*)([-*]|\d+\.)\s+/.test(lines[i]) &&
        !(/^\s*\|/.test(lines[i]) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1]))) {
        para.push(lines[i].trim()); i++;
      }
      out.push("<p>" + inline(para.join(" ")) + "</p>");
    }
    return out.join("\n");
  }

  KA.md = { render: render, inline: inline, codeBlock: codeBlock, esc: esc };
})(window.KA);
