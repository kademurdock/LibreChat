/* Family library access, for the library owner (Sep 24 2026).
 * Her ask: the shared collection is family only; accounts made later wait for
 * her yes. This section lists every account with its access in one plain
 * sentence and a button that says exactly what it will do. Focus stays on the
 * button you pressed; each change is announced once. A trusted uploader's
 * earlier uploads can be previewed and then approved together. */
(function () {
  'use strict';
  var started = false;
  window.setupLibraryAccess = function (api, say) {
    if (started) return;
    var root = document.getElementById('familyAccess');
    if (!root) return;
    started = true;
    var busy = false;
    function element(tag, text) {
      var node = document.createElement(tag);
      if (text) node.textContent = text;
      return node;
    }
    function button(label, className) {
      var node = element('button', label);
      node.type = 'button';
      node.className = className || 'act quiet';
      return node;
    }
    /* aria-disabled rather than disabled, so a pressed button keeps keyboard focus. */
    async function run(node, work) {
      if (busy) return;
      busy = true;
      node.setAttribute('aria-disabled', 'true');
      try {
        await work();
      } catch (error) {
        announce(error.message);
      } finally {
        busy = false;
        node.removeAttribute('aria-disabled');
      }
    }
    var heading = element('h2', 'Family library access');
    heading.id = 'h-family-access';
    root.appendChild(heading);
    root.appendChild(
      element(
        'p',
        'Family accounts from before September 24 keep the shared collection. Accounts made after that see only their own uploads until you turn family access on. Turning it off never touches anyone’s own uploads.',
      ),
    ).className = 'hint';
    /* The page's one live region (say) carries each change; a paragraph of its own would sit in
     * browse mode repeating the last receipt. Only an older page without say gets one. */
    var status = null;
    if (typeof say !== 'function') {
      status = element('p');
      status.setAttribute('role', 'status');
      root.appendChild(status);
    }
    function announce(text) {
      if (!status) return say(text);
      status.textContent = '';
      setTimeout(function () {
        status.textContent = text;
      }, 30);
    }
    var list = element('ul');
    list.className = 'plain';
    list.setAttribute('aria-labelledby', 'h-family-access');
    root.appendChild(list);

    function accessLabel(account) {
      return (account.member ? 'Turn off family access for ' : 'Turn on family access for ') + account.name;
    }
    function renderAccount(account) {
      var row = element('li');
      var words = element('span', account.name + '. ' + account.status);
      words.className = 't';
      row.appendChild(words);
      if (account.changeable) {
        var toggle = button(accessLabel(account));
        toggle.onclick = function () {
          run(toggle, async function () {
            var result = await api('/membership', {
              json: { id: account.id, access: account.member ? 'none' : 'family' },
            });
            account = result.account;
            words.textContent = account.name + '. ' + account.status;
            toggle.textContent = accessLabel(account);
            announce(account.name + (account.member ? ' now has family access.' : ' no longer has family access.'));
          });
        };
        row.appendChild(toggle);
      }
      if (account.trusted && account.member) row.appendChild(backlog(account));
      return row;
    }

    /* A trusted uploader's uploads that were waiting before the rule existed. */
    function backlog(account) {
      var box = element('div');
      var check = button('Check ' + account.name + '’s earlier uploads');
      var result = element('p');
      result.hidden = true;
      result.tabIndex = -1;
      var approve = button('', 'act primary');
      approve.hidden = true;
      var titles = element('details');
      titles.hidden = true;
      function describe(receipt) {
        var n = receipt.approved.length;
        var parts = [];
        if (receipt.applied) parts.push(n ? 'Done. ' + n + ' item' + (n === 1 ? ' is' : 's are') + ' in the family library now, and ' + account.name + ' was told.' : 'Nothing was waiting.');
        else parts.push(n ? n + ' item' + (n === 1 ? ' is' : 's are') + ' waiting for the family library.' : 'Nothing is waiting. Her earlier uploads are all decided.');
        if (receipt.stillUploading) parts.push(receipt.stillUploading + ' still uploading, left waiting.');
        if (receipt.links) parts.push(receipt.links + ' link suggestion' + (receipt.links === 1 ? '' : 's') + ' stay in your queue.');
        if (receipt.notRequested) parts.push(receipt.notRequested + ' item' + (receipt.notRequested === 1 ? '' : 's') + ' on her own shelf she never asked to share, left as ' + (receipt.notRequested === 1 ? 'it is.' : 'they are.'));
        if (receipt.missing) parts.push(receipt.missing + ' request' + (receipt.missing === 1 ? '' : 's') + ' for deleted items, left for you.');
        return parts.join(' ');
      }
      function listTitles(receipt) {
        titles.replaceChildren();
        if (!receipt.approved.length) {
          titles.hidden = true;
          return;
        }
        titles.appendChild(element('summary', (receipt.applied ? 'Titles approved' : 'Titles waiting') + ' (' + receipt.approved.length + ')'));
        var ul = element('ul');
        receipt.approved.forEach(function (item) {
          var li = element('li');
          var link = element('a', item.title);
          link.href = '/library?book=' + encodeURIComponent(item.id);
          li.appendChild(link);
          ul.appendChild(li);
        });
        titles.appendChild(ul);
        titles.hidden = false;
      }
      check.onclick = function () {
        run(check, async function () {
          var receipt = await api('/membership/approve-uploads', { json: { id: account.id } });
          result.textContent = describe(receipt);
          result.hidden = false;
          listTitles(receipt);
          var n = receipt.approved.length;
          approve.hidden = !n;
          approve.textContent = 'Put ' + (n === 1 ? 'it' : 'all ' + n) + ' in the family library';
          announce(result.textContent);
        });
      };
      approve.onclick = function () {
        run(approve, async function () {
          var receipt = await api('/membership/approve-uploads', { json: { id: account.id, apply: true } });
          result.textContent = describe(receipt);
          listTitles(receipt);
          /* The pressed button goes away, so focus moves to the receipt and it is read from there. */
          result.focus();
          approve.hidden = true;
        });
      };
      box.appendChild(check);
      box.appendChild(result);
      box.appendChild(approve);
      box.appendChild(titles);
      return box;
    }

    root.hidden = false;
    api('/membership')
      .then(function (data) {
        list.replaceChildren();
        data.accounts.forEach(function (account) {
          list.appendChild(renderAccount(account));
        });
        if (!data.accounts.length) list.appendChild(element('li', 'No accounts found.'));
      })
      .catch(function (error) {
        list.replaceChildren(element('li', 'Could not load accounts: ' + error.message));
      });
  };
})();
