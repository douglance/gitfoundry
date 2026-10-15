export function createBrowserControls(evaluate, waitFor) {
  async function click(selector) {
    await evaluate('(() => { const element = document.querySelector(' + JSON.stringify(selector) + '); if (!element || element.disabled) throw new Error("Missing or disabled control"); element.click(); })()');
  }
  
  async function clickButton(label, scope) {
    await evaluate('(() => { const element = Array.from(document.querySelectorAll(' + JSON.stringify(scope + ' button') + ')).find(item => item.textContent.trim() === ' + JSON.stringify(label) + '); if (!element || element.disabled) throw new Error("Missing or disabled button"); element.click(); })()');
  }
  
  async function fill(selector, value) {
    await evaluate('(() => { const element = document.querySelector(' + JSON.stringify(selector) + '); if (!element) throw new Error("Missing field"); const prototype = element.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(prototype, "value").set.call(element, ' + JSON.stringify(value) + '); element.dispatchEvent(new Event("input", { bubbles: true })); })()');
  }
  
  async function selectFork(version) {
    await click('[data-fork-node="' + version + '"]');
    await waitFor('document.querySelector("[data-fork-review]")?.innerText.includes(' + JSON.stringify(version) + ')', 'selected fork inspector displays the requested exact version');
  }
  return { click, clickButton, fill, selectFork };
}
