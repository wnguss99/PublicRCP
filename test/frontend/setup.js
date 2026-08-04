// Setup file for frontend tests
// Load jQuery for testing
const fs = require('fs');
const path = require('path');

// ComposerGate is the single owner of the chat composer's enabled state and is
// loaded first in index.html, so every module may assume it exists. Mirror that
// here rather than letting each suite stub it — a stub would let a module drift
// away from the real gate's contract without any test noticing.
global.ComposerGate = require('../../public/js/modules/composer-gate.js');

// Same reasoning for ModelCatalog: it is the only source of model ids for the
// frontend and index.html loads it for every page, so modules reference the bare
// global. Suites that did not stub it failed with `ModelCatalog is not defined`
// even though the product was fine. Load the real module rather than a stub so a
// module cannot drift away from the catalog's contract unnoticed. Seed it per
// suite with ModelCatalog.setModels().
//
// Required for its side effect only — unlike composer-gate this is a plain
// browser IIFE that assigns window.ModelCatalog and exports nothing, so
// assigning the return value would clobber the real object with {}.
require('../../public/js/modules/model-catalog.js');

beforeEach(() => {
  // No lock may survive into another test.
  global.ComposerGate._reset();
});

afterEach(() => {
  global.ComposerGate.stop();
});

// Create a minimal jQuery mock for testing
global.$ = global.jQuery = function(selector) {
  const elements = [];

  if (typeof selector === 'function') {
    // $(document).ready handler
    selector();
    return;
  }

  if (typeof selector === 'string') {
    if (selector.startsWith('<')) {
      // Create element from HTML string
      const div = document.createElement('div');
      div.innerHTML = selector;
      elements.push(...div.children);
    } else {
      // Query selector
      elements.push(...document.querySelectorAll(selector));
    }
  } else if (Array.isArray(selector)) {
    elements.push(...selector);
  } else if (selector instanceof Element || selector === document) {
    elements.push(selector);
  }

  const $obj = {
    length: elements.length,
    elements: elements,
    // Numeric indexing like real jQuery
    ...Object.fromEntries(elements.map((el, i) => [i, el])),

    on: function(event, selectorOrHandler, handler) {
      const actualHandler = handler || selectorOrHandler;
      const delegateSelector = handler ? selectorOrHandler : null;

      elements.forEach(el => {
        if (delegateSelector) {
          el.addEventListener(event, function(e) {
            const target = e.target.closest(delegateSelector);

            if (target) {
              actualHandler.call(target, e);
            }
          });
        } else {
          el.addEventListener(event, actualHandler);
        }
      });

      return $obj;
    },

    closest: function(selector) {
      if (elements.length === 0) return $({ length: 0, elements: [] });
      const closest = elements[0].closest(selector);

      return $(closest || { length: 0, elements: [] });
    },

    submit: function() {
      elements.forEach(el => {
        if (el.tagName === 'FORM') {
          el.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        }
      });

      return $obj;
    },

    val: function(value) {
      if (value === undefined) {
        return elements[0] ? elements[0].value : '';
      }
      elements.forEach(el => { el.value = value; });

      return $obj;
    },

    focus: function() {
      if (elements[0]) elements[0].focus();

      return $obj;
    },

    text: function(value) {
      if (value === undefined) {
        return elements[0] ? elements[0].textContent : '';
      }
      elements.forEach(el => { el.textContent = value; });

      return $obj;
    },

    css: function(property, value) {
      if (typeof property === 'string' && value === undefined) {
        // Getter
        if (elements[0]) {
          return window.getComputedStyle(elements[0])[property];
        }

        return '';
      }
      // Setter
      elements.forEach(el => {
        if (typeof property === 'string') {
          el.style[property] = value;
        }
      });

      return $obj;
    },

    addClass: function(className) {
      elements.forEach(el => {
        el.classList.add(className);
      });

      return $obj;
    },

    removeClass: function(className) {
      elements.forEach(el => {
        el.classList.remove(className);
      });

      return $obj;
    },

    hasClass: function(className) {
      return elements[0] ? elements[0].classList.contains(className) : false;
    },

    prop: function(name, value) {
      if (value === undefined) {
        return elements[0] ? elements[0][name] : undefined;
      }
      elements.forEach(el => { el[name] = value; });

      return $obj;
    },

    attr: function(name, value) {
      if (value === undefined) {
        return elements[0] ? elements[0].getAttribute(name) : undefined;
      }
      elements.forEach(el => { el.setAttribute(name, value); });

      return $obj;
    },

    html: function(value) {
      if (value === undefined) {
        return elements[0] ? elements[0].innerHTML : '';
      }
      elements.forEach(el => { el.innerHTML = value; });

      return $obj;
    },

    append: function(content) {
      elements.forEach(el => {
        if (typeof content === 'string') {
          el.insertAdjacentHTML('beforeend', content);
        } else if (content instanceof Element) {
          el.appendChild(content);
        }
      });

      return $obj;
    },

    empty: function() {
      elements.forEach(el => { el.innerHTML = ''; });

      return $obj;
    },

    is: function(selector) {
      if (selector === ':visible') {
        return elements[0] ? !elements[0].classList.contains('hidden') : false;
      }

      return elements[0] ? elements[0].matches(selector) : false;
    },

    off: function() {
      return $obj;
    },

    data: function(key, value) {
      if (value === undefined) {
        return elements[0] ? elements[0].dataset[key] : undefined;
      }
      elements.forEach(el => { el.dataset[key] = value; });

      return $obj;
    },

    parent: function() {
      const parents = [];
      elements.forEach(el => {
        if (el.parentNode) parents.push(el.parentNode);
      });

      return $(parents.length > 0 ? parents : { length: 0, elements: [] });
    },

    scrollTop: function(value) {
      if (value === undefined) {
        return elements[0] ? elements[0].scrollTop : 0;
      }
      elements.forEach(el => { el.scrollTop = value; });

      return $obj;
    },

    find: function(selector) {
      const found = [];
      elements.forEach(el => {
        found.push(...el.querySelectorAll(selector));
      });

      return $(found.length > 0 ? found : { length: 0, elements: [] });
    },

    each: function(callback) {
      elements.forEach((el, index) => {
        callback.call(el, index, el);
      });

      return $obj;
    },

    [Symbol.iterator]: function*() {
      for (const el of elements) {
        yield el;
      }
    }
  };

  return $obj;
};

// Helper to create keyboard events
global.createKeyboardEvent = function(type, options) {
  return new KeyboardEvent(type, {
    bubbles: true,
    cancelable: true,
    ...options
  });
};
