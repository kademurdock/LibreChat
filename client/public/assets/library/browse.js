(function () {
  'use strict';
  /* Nov 10 2026 (redesign): the place you are in lives in the address.
   * Search words, every filter, the subject you are browsing under and the page number are query
   * parameters (q, scope, kind, type, decade, sort, under, page), so the browser's Back button
   * walks back through searches and pages, a reload lands on the same list, and a link can be
   * sent to someone. Defaults are left out, so a plain address is the plain first page.
   * Pages are real pages of 60 (Previous page, Next page, "Page 2 of 9"), never one growing list.
   *
   * Focus and speech after each move:
   *  - a search, a filter, Clear: focus stays where it is; the count is spoken once.
   *  - a "start here" button, a page turn, Back or Forward: focus goes to the Results heading
   *    (the list under it is new), and the count and page are spoken once.
   * `loaded` (optional) runs after each fresh list is drawn, so the page can put focus back on the
   * item a person just came back from. */
  var FIELDS = {
    q: 'searchBox',
    scope: 'libraryScope',
    kind: 'browseKind',
    type: 'browseType',
    decade: 'browseDecade',
    sort: 'browseSort',
    under: 'browsePath',
  };
  var DEFAULTS = { scope: 'public', sort: 'recent' };
  var PAGE = 60;
  /* One writer for the address, shared with the page's own script (the folders use it too).
   * changes: { name: value }, where an empty value removes the name. how: 'push' or 'replace'. */
  window.kadeLibraryAddress = {
    params: function () {
      return new URLSearchParams(location.search);
    },
    set: function (changes, how) {
      var params = new URLSearchParams(location.search);
      Object.keys(changes).forEach(function (name) {
        var value = changes[name];
        if (value === null || value === undefined || value === '') params.delete(name);
        else params.set(name, String(value));
      });
      var query = params.toString();
      var address = location.pathname + (query ? '?' + query : '');
      if (address === location.pathname + location.search) return false;
      try {
        if (how === 'replace') history.replaceState(null, '', address);
        else history.pushState(null, '', address);
      } catch (error) {
        return false;
      }
      return true;
    },
  };
  window.setupLibraryBrowse = function (api, say, bookLi, scopeChanged, loaded) {
    var get = function (id) {
      return document.getElementById(id);
    };
    var form = get('browseForm'),
      list = get('browseList'),
      pager = get('browsePager');
    var run = 0,
      active = null,
      pageNumber = 1,
      pages = 1,
      lastPush = 0,
      baseTitle = document.title;
    function fillMenu(id, rows, label) {
      var select = get(id),
        chosen = select.value;
      select.replaceChildren(new Option(label, ''));
      rows.forEach(function (row) {
        if (!row._id) return;
        var names = {
          book: 'Books',
          newspaper: 'Newspapers',
          newsletter: 'Newsletters',
          yearbook: 'Yearbooks',
          audiobook: 'Audiobooks',
          commercials: 'Commercials',
          radio: 'Radio',
          music: 'Music',
          movie: 'Movies',
          tv: 'Television',
          cassette: 'Cassettes',
          vhs: 'Home video',
          psa: 'Public service announcements',
          other: 'Other',
        };
        select.add(new Option((names[row._id] || row._id) + ' (' + row.count + ')', row._id));
      });
      if (
        chosen &&
        !rows.some(function (row) {
          return row._id === chosen;
        })
      ) {
        select.add(new Option(chosen + ' (0)', chosen));
      }
      select.value = chosen;
    }
    /* what the server is asked: its own names (path, a page counted from 0) */
    function state() {
      var parameters = new URLSearchParams({
        q: get('searchBox').value.trim(),
        scope: get('libraryScope').value,
        kind: get('browseKind').value,
        type: get('browseType').value,
        decade: get('browseDecade').value,
        sort: get('browseSort').value,
        path: get('browsePath').value,
      });
      if (pageNumber > 1) parameters.set('page', String(pageNumber - 1));
      return parameters;
    }
    /* what the address holds: the same choices, defaults left out, the page counted from 1 */
    function addressChanges() {
      var changes = {};
      Object.keys(FIELDS).forEach(function (name) {
        var value = get(FIELDS[name]).value.trim();
        changes[name] = value === (DEFAULTS[name] || '') ? '' : value;
      });
      changes.page = pageNumber > 1 ? pageNumber : '';
      return changes;
    }
    function fromAddress() {
      var params = window.kadeLibraryAddress.params();
      Object.keys(FIELDS).forEach(function (name) {
        var field = get(FIELDS[name]),
          value = params.get(name) || DEFAULTS[name] || '';
        if (
          field.tagName === 'SELECT' &&
          value &&
          !Array.from(field.options).some(function (option) {
            return option.value === value;
          })
        ) {
          if (name === 'type' || name === 'decade') field.add(new Option(value, value));
          else value = DEFAULTS[name] || '';
        }
        field.value = value;
      });
      var wanted = parseInt(params.get('page'), 10);
      pageNumber = wanted > 1 && wanted < 10000 ? wanted : 1;
      showLocation();
    }
    function showLocation() {
      get('browseLocation').hidden = !get('browsePath').value;
      get('browseLocationName').textContent = get('browsePath').value.split('/').join(' · ');
    }
    function words() {
      return get('browsePath').value
        ? get('browseLocationName').textContent
        : get('searchBox').value.trim();
    }
    function showTitle() {
      var found = words();
      document.title =
        (found ? (get('browsePath').value ? '' : 'Search: ') + found + ' — ' : '') +
        (pageNumber > 1 ? 'page ' + pageNumber + ' — ' : '') +
        baseTitle;
    }
    /* how: 'push' (a new step Back can return to), 'replace', or 'none' (the address already says it).
     * A run of filter changes close together (arrowing through a menu) is one step, not six. */
    function writeAddress(how) {
      if (how === 'none') return;
      var now = Date.now();
      if (how === 'filter') how = now - lastPush < 1500 ? 'replace' : 'push';
      if (window.kadeLibraryAddress.set(addressChanges(), how) && how === 'push') lastPush = now;
    }
    /* options: how (see writeAddress), toResults (focus the Results heading), show (scroll the
     * first row into view when it is below the screen; focus does not move). */
    async function load(options) {
      options = options || {};
      var parameters = state(),
        signature = parameters.toString();
      if (active) active.abort();
      active = new AbortController();
      var request = ++run;
      list.replaceChildren();
      pager.hidden = true;
      get('browseCount').textContent = 'Loading…';
      list.setAttribute('aria-busy', 'true');
      writeAddress(options.how || 'none');
      showTitle();
      try {
        var result = await api('/browse?' + parameters.toString(), { signal: active.signal });
        if (request !== run || signature !== state().toString()) return;
        pages = Math.max(1, Math.ceil((result.total || 0) / PAGE));
        if (pageNumber > pages) {
          /* an old link to a page that is no longer there: the last real page, in its place */
          pageNumber = pages;
          load({ how: 'replace', toResults: options.toResults, show: options.show });
          return;
        }
        fillMenu('browseType', result.types, 'All types');
        fillMenu('browseDecade', result.decades, 'All decades');
        result.items.forEach(function (item) {
          var li = bookLi(item, 'archive');
          var meta = li.querySelector('.meta');
          var placement = [];
          if (item.decade) placement.push(item.decade);
          if (item.path)
            placement.push(
              item.path
                .split('/')
                .filter(function (part) {
                  return part !== item.decade;
                })
                .join(' · '),
            );
          if (meta && placement.length && !shortRows()) {
            var line = document.createElement('span');
            line.className = 'meta place';
            line.textContent = placement.join(' · ');
            li.querySelector('.book').appendChild(line);
          }
          list.appendChild(li);
        });
        if (!list.children.length) {
          var empty = document.createElement('li');
          empty.textContent = 'Nothing matches these filters. Try another type, decade or search.';
          list.appendChild(empty);
        }
        var first = (pageNumber - 1) * PAGE + 1,
          last = first + result.items.length - 1,
          paged = pages > 1 ? 'Page ' + pageNumber + ' of ' + pages : '';
        get('browseCount').textContent =
          result.total +
          (result.total === 1 ? ' item' : ' items') +
          (paged ? ' · ' + paged.toLowerCase() + ' · showing ' + first + ' to ' + last : '');
        pager.hidden = pages <= 1;
        get('browsePageInfo').textContent = paged;
        get('browsePrev').disabled = pageNumber <= 1;
        get('browseNext').disabled = pageNumber >= pages;
        say(
          result.total +
            (result.total === 1 ? ' item matches.' : ' items match.') +
            (paged ? ' ' + paged + '.' : ''),
        );
        var heading = get('h-results');
        if (heading) {
          var found = words();
          heading.textContent = found ? 'Results: ' + found : 'Results';
          if (options.toResults) {
            heading.focus();
            try {
              heading.scrollIntoView({ block: 'start' });
            } catch (error) {}
          }
        }
        if (options.show && !options.toResults) {
          try {
            var count = get('browseCount'),
              row = list.firstElementChild || count;
            if (row.getBoundingClientRect().bottom > window.innerHeight)
              row.scrollIntoView({ block: 'nearest' });
            else if (count.getBoundingClientRect().top < 0)
              count.scrollIntoView({ block: 'nearest' });
          } catch (error) {}
        }
        if (loaded) loaded();
      } catch (error) {
        if (request !== run || error.name === 'AbortError') return;
        get('browseCount').textContent = 'The library could not be loaded.';
        say(error.message);
      } finally {
        if (request === run) list.removeAttribute('aria-busy');
      }
    }
    /* Short rows (Nov 10 2026): the folder line under every result is a lot of repeated words by
     * ear ("1990s, Video, Ozarks, Local Commercials" sixty times). One checkbox under the list
     * leaves it off; the choice is remembered on this device. The folder is still on the item. */
    function shortRows() {
      try {
        return localStorage.getItem('kade.library.shortRows') === '1';
      } catch (error) {
        return false;
      }
    }
    if (get('shortRows')) {
      get('shortRows').checked = shortRows();
      get('shortRows').onchange = function () {
        try {
          localStorage.setItem('kade.library.shortRows', this.checked ? '1' : '0');
        } catch (error) {}
        var lines = list.querySelectorAll('.meta.place');
        if (this.checked)
          lines.forEach(function (line) {
            line.remove();
          });
        else load({ how: 'none' });
        if (this.checked) say('Short rows on.');
      };
    }
    function fresh(how, toResults) {
      pageNumber = 1;
      load({ how: how, toResults: toResults, show: !toResults });
    }
    form.onsubmit = function (event) {
      event.preventDefault();
      fresh('push');
    };
    ['libraryScope', 'browseKind', 'browseType', 'browseDecade', 'browseSort'].forEach(
      function (id) {
        get(id).onchange = function () {
          fresh('filter');
          if (id === 'libraryScope' && scopeChanged) scopeChanged();
        };
      },
    );
    function turn(by) {
      var target = pageNumber + by;
      if (target < 1 || target > pages) return;
      pageNumber = target;
      load({ how: 'push', toResults: true });
    }
    get('browsePrev').onclick = function () {
      turn(-1);
    };
    get('browseNext').onclick = function () {
      turn(1);
    };
    get('browseClear').onclick = function () {
      form.reset();
      get('browsePath').value = '';
      showLocation();
      fresh('push');
    };
    get('browsePathClear').onclick = function () {
      get('browsePath').value = '';
      showLocation();
      fresh('push');
    };
    if (get('discoveryLinks'))
      get('discoveryLinks').onclick = function (event) {
        var button = event.target.closest('button');
        if (!button) return;
        get('searchBox').value = button.dataset.query || '';
        get('browsePath').value = button.dataset.folder || '';
        showLocation();
        fresh('push', true);
      };
    /* Back and Forward: the address has already changed; the form and the list follow it. */
    window.addEventListener('popstate', function () {
      var before = state().toString();
      fromAddress();
      if (state().toString() === before) return;
      load({ how: 'none', toResults: true });
    });
    fromAddress();
    load({ how: 'none' });
    return {
      reload: function () {
        load({ how: 'none' });
      },
    };
  };
})();
