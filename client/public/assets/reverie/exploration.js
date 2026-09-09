(function () {
  'use strict';
  var api,
    room,
    busy = false;
  var $ = function (id) {
    return document.getElementById(id);
  };
  function render(next) {
    room = next;
    $('explorationPanel').hidden = false;
    $('explorationTitle').textContent = 'Explore from ' + room.name;
    var people = room.peopleDetail || [];
    $('explorationSummary').textContent = people.length
      ? 'Here with you: ' +
        people
          .map(function (p) {
            return p.line;
          })
          .join('; ') +
        '.'
      : 'Nobody else is here. Take an exit to explore.';
    var list = $('connectedExits');
    var existing = new Map(
      Array.from(list.children).map(function (b) {
        return [b.dataset.dir, b];
      }),
    );
    (room.exitsDetail || []).forEach(function (exit) {
      var button = existing.get(exit.dir);
      if (!button) {
        button = document.createElement('button');
        button.type = 'button';
        button.dataset.dir = exit.dir;
        list.appendChild(button);
      }
      existing.delete(exit.dir);
      button.className = 'connected-exit' + (exit.returning ? ' returning' : '');
      button.textContent =
        exit.label +
        ' — ' +
        exit.to +
        (exit.missing ? ' (unavailable)' : exit.locked ? ' (locked)' : '') +
        (exit.returning ? ' · way back' : '');
      button.setAttribute(
        'aria-label',
        'Travel ' +
          exit.label +
          ' to ' +
          exit.to +
          (exit.locked ? ', locked' : '') +
          (exit.returning ? ', your last room' : ''),
      );
      button.dataset.missing = exit.missing ? 'true' : 'false';
      button.disabled = busy || !!exit.missing;
      var origin = room.roomId;
      button.onclick = function () {
        api.send('go ' + exit.dir, origin, { dir: exit.dir, toId: exit.toId });
      };
    });
    existing.forEach(function (button) {
      var focused = document.activeElement === button;
      button.remove();
      if (focused) $('cmdInput').focus();
    });
  }
  window.ReverieExplore = {
    init: function (callbacks) {
      api = callbacks;
      $('sayHere').onclick = function () {
        api.compose('say ');
      };
    },
    render: render,
    busy: function (value) {
      busy = value;
      $('connectedExits').setAttribute('aria-busy', String(value));
      Array.from($('connectedExits').children).forEach(function (button) {
        button.disabled = value || button.dataset.missing === 'true';
      });
    },
  };
})();
