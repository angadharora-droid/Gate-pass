// Keyboard handling shared by the .suggest-menu dropdowns (items grid, vendor
// picker): ↓/↑ move the highlight, Enter picks it, Esc closes. `active` is the
// highlighted index, -1 = nothing highlighted — so Enter on a free-typed value
// never picks a suggestion by accident.
export function suggestKeyNav(e, { count, active, setActive, pick, close }) {
  if (e.key === 'Escape') { close(); return; }
  if (!count) return;
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    setActive(active + 1 >= count ? 0 : active + 1);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    setActive(active <= 0 ? count - 1 : active - 1);
  } else if (e.key === 'Enter' && active >= 0) {
    e.preventDefault();
    pick(active);
  }
}

// Scroll the menu (only the menu — it is position:fixed) so the highlighted
// row stays in view while arrowing through a long list.
export function keepActiveVisible(menu) {
  const el = menu?.querySelector('.suggest-item.active');
  if (!el) return;
  if (el.offsetTop < menu.scrollTop) menu.scrollTop = el.offsetTop;
  else if (el.offsetTop + el.offsetHeight > menu.scrollTop + menu.clientHeight)
    menu.scrollTop = el.offsetTop + el.offsetHeight - menu.clientHeight;
}
