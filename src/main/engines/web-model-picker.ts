/**
 * In-page scripts for the web engines' native model pickers. Both sites keep
 * model choice inside their own UI, so ND reads and changes it through the
 * visible page rather than inventing a model catalog.
 */
export interface WebModelOption {
  id: string
  name: string
  description?: string
  selected?: boolean
  disabled?: boolean
}

export interface WebModelMenuResult {
  ok: boolean
  reason?: string
  models: WebModelOption[]
  current?: string
  available?: string[]
  applied?: boolean
}

/**
 * Gemini's mode button names the active mode ("Open mode picker, currently
 * Flash"). A pinned model that ends with that short name is already applied,
 * so a turn can skip opening the menu entirely.
 */
export function geminiModelTriggerScript(): string {
  return `(() => {
    const button = document.querySelector('button[data-test-id="bard-mode-menu-button"]');
    if (!(button instanceof HTMLElement)) return { ok: false, current: '' };
    const aria = button.getAttribute('aria-label') || '';
    const match = aria.match(/currently\\s+(.+)$/i);
    return {
      ok: true,
      current: String(match ? match[1] : button.innerText || '').replace(/\\s+/g, ' ').trim(),
    };
  })()`
}

/**
 * Gemini's mode menu (button[data-test-id="bard-mode-menu-button"]) mixes model
 * entries with a "Thinking level" submenu; only `data-mode-id` items are models.
 */
export function geminiModelMenuScript(select?: string): string {
  const requested = JSON.stringify(select ?? null)
  return `(async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const clean = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
    const trigger = () => document.querySelector('button[data-test-id="bard-mode-menu-button"]');
    const menu = () => document.querySelector('gem-menu');
    const itemElements = () => Array.from(document.querySelectorAll('gem-menu-item[data-mode-id]'));
    const labelOf = (element) => clean((element.querySelector('.label') || {}).textContent);
    const descriptionOf = (element) => clean((element.querySelector('.sublabel') || {}).textContent);
    const readModels = () => itemElements().map((element) => {
      const id = labelOf(element);
      const description = descriptionOf(element);
      return {
        id,
        name: id,
        ...(description ? { description } : {}),
        selected: element.classList.contains('selected'),
        disabled: element.getAttribute('aria-disabled') === 'true',
      };
    }).filter((model) => model.id);
    const closeMenu = async () => {
      if (!menu()) return;
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }));
      for (let index = 0; index < 20 && menu(); index += 1) await sleep(50);
      if (menu()) {
        const button = trigger();
        if (button instanceof HTMLElement) button.click();
        for (let index = 0; index < 20 && menu(); index += 1) await sleep(50);
      }
    };
    const openMenu = async () => {
      if (menu()) return true;
      const button = trigger();
      if (!(button instanceof HTMLElement)) return false;
      button.click();
      for (let index = 0; index < 60 && !menu(); index += 1) await sleep(50);
      return Boolean(menu());
    };
    const button = trigger();
    if (!(button instanceof HTMLElement)) return { ok: false, reason: 'model-button-missing', models: [] };
    const wasOpen = Boolean(menu());
    if (!(await openMenu())) return { ok: false, reason: 'model-menu-did-not-open', models: [] };
    const models = readModels();
    const current = (models.find((model) => model.selected) || {}).id;
    const wanted = ${requested};
    const normalize = (value) => clean(value).toLowerCase();
    if (wanted) {
      const target = models.find((model) => normalize(model.id) === normalize(wanted));
      if (!target) {
        await closeMenu();
        return {
          ok: false,
          reason: 'model-not-found',
          models,
          ...(current ? { current } : {}),
          available: models.map((model) => model.id),
        };
      }
      if (target.disabled) {
        if (!wasOpen) await closeMenu();
        return {
          ok: false,
          reason: 'model-unavailable',
          models,
          ...(current ? { current } : {}),
          available: models.filter((model) => !model.disabled).map((model) => model.id),
        };
      }
      if (target.selected) {
        if (!wasOpen) await closeMenu();
        return { ok: true, applied: false, ...(current ? { current } : {}), models };
      }
      const element = itemElements().find((candidate) => labelOf(candidate) === target.id);
      if (!(element instanceof HTMLElement)) {
        await closeMenu();
        return { ok: false, reason: 'model-item-missing', models, available: models.map((model) => model.id) };
      }
      element.click();
      for (let index = 0; index < 60 && menu(); index += 1) await sleep(50);
      const reopened = await openMenu();
      const after = reopened ? readModels() : [];
      const selected = (after.find((model) => model.selected) || {}).id;
      await closeMenu();
      if (!selected || normalize(selected) !== normalize(target.id)) {
        return {
          ok: false,
          reason: 'model-not-applied',
          models: after.length > 0 ? after : models,
          ...(selected ? { current: selected } : {}),
          available: models.map((model) => model.id),
        };
      }
      return { ok: true, applied: true, current: selected, models: after };
    }
    if (!wasOpen) await closeMenu();
    return models.length > 0
      ? { ok: true, models, ...(current ? { current } : {}) }
      : { ok: false, reason: 'no-models', models: [] };
  })()`
}

/**
 * ChatGPT's model switcher mixes model radios with a "Power" slider row; only
 * visible menuitemradio entries are models. Radix rows react to pointer events,
 * so selection dispatches the pointer sequence before the click.
 */
export function chatGptModelMenuScript(select?: string): string {
  const requested = JSON.stringify(select ?? null)
  return `(async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const clean = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
    const trigger = () => Array.from(document.querySelectorAll('button'))
      .find((element) => /^select chatgpt model/i.test(clean(element.getAttribute('aria-label') || '')));
    const visibleMenus = () => Array.from(document.querySelectorAll('[role="menu"]'))
      .filter((element) => element.getClientRects().length > 0);
    const menu = () => visibleMenus()[0];
    const itemElements = () => {
      const root = menu();
      if (!root) return [];
      const seen = new Set();
      return Array.from(root.querySelectorAll('[role="menuitemradio"]'))
        .filter((element) => element.getClientRects().length > 0)
        .map((element) => ({ element, id: clean(element.innerText || element.textContent) }))
        .filter((model) => model.id && !seen.has(model.id) && Boolean(seen.add(model.id)));
    };
    const readModels = () => itemElements().map(({ element, id }) => ({
      id,
      name: id,
      selected: element.getAttribute('aria-checked') === 'true',
      disabled: element.getAttribute('aria-disabled') === 'true' || element.closest('[aria-disabled="true"]') !== null,
    }));
    const press = (element) => {
      const options = { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', button: 0 };
      element.dispatchEvent(new PointerEvent('pointerdown', options));
      element.dispatchEvent(new PointerEvent('pointerup', options));
      element.click();
    };
    const closeMenu = async () => {
      if (!menu()) return;
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }));
      for (let index = 0; index < 20 && menu(); index += 1) await sleep(50);
      if (menu()) {
        const button = trigger();
        if (button instanceof HTMLElement) press(button);
        for (let index = 0; index < 20 && menu(); index += 1) await sleep(50);
      }
    };
    const openMenu = async () => {
      if (menu()) return true;
      const button = trigger();
      if (!(button instanceof HTMLElement)) return false;
      press(button);
      for (let index = 0; index < 60 && !menu(); index += 1) await sleep(50);
      return Boolean(menu());
    };
    const button = trigger();
    if (!(button instanceof HTMLElement)) return { ok: false, reason: 'model-button-missing', models: [] };
    const wasOpen = Boolean(menu());
    if (!(await openMenu())) return { ok: false, reason: 'model-menu-did-not-open', models: [] };
    const models = readModels();
    const current = (models.find((model) => model.selected) || {}).id;
    const wanted = ${requested};
    const normalize = (value) => clean(value).toLowerCase();
    if (wanted) {
      const target = models.find((model) => normalize(model.id) === normalize(wanted));
      if (!target) {
        await closeMenu();
        return {
          ok: false,
          reason: 'model-not-found',
          models,
          ...(current ? { current } : {}),
          available: models.map((model) => model.id),
        };
      }
      if (target.disabled) {
        if (!wasOpen) await closeMenu();
        return {
          ok: false,
          reason: 'model-unavailable',
          models,
          ...(current ? { current } : {}),
          available: models.filter((model) => !model.disabled).map((model) => model.id),
        };
      }
      if (target.selected) {
        if (!wasOpen) await closeMenu();
        return { ok: true, applied: false, ...(current ? { current } : {}), models };
      }
      const element = itemElements().find((candidate) => candidate.id === target.id)?.element;
      if (!(element instanceof HTMLElement)) {
        await closeMenu();
        return { ok: false, reason: 'model-item-missing', models, available: models.map((model) => model.id) };
      }
      press(element);
      for (let index = 0; index < 60 && menu(); index += 1) await sleep(50);
      const reopened = await openMenu();
      const after = reopened ? readModels() : [];
      const selected = (after.find((model) => model.selected) || {}).id;
      await closeMenu();
      if (!selected || normalize(selected) !== normalize(target.id)) {
        return {
          ok: false,
          reason: 'model-not-applied',
          models: after.length > 0 ? after : models,
          ...(selected ? { current: selected } : {}),
          available: models.map((model) => model.id),
        };
      }
      return { ok: true, applied: true, current: selected, models: after };
    }
    if (!wasOpen) await closeMenu();
    return models.length > 0
      ? { ok: true, models, ...(current ? { current } : {}) }
      : { ok: false, reason: 'no-models', models: [] };
  })()`
}
