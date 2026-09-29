'use strict';

(() => {
  let modal;
  let closeButton;
  let previousFocus = null;

  function openModal(trigger) {
    previousFocus = trigger instanceof HTMLElement ? trigger : document.activeElement;
    modal.hidden = false;
    document.body.classList.add('modal-open');
    closeButton.focus();
  }

  function closeModal() {
    if (modal.hidden) {
      return;
    }
    modal.hidden = true;
    document.body.classList.remove('modal-open');
    if (previousFocus instanceof HTMLElement && previousFocus.isConnected) {
      previousFocus.focus();
    }
    previousFocus = null;
  }

  function initialise() {
    modal = document.getElementById('episodeModal');
    closeButton = document.getElementById('episodeModalClose');
    if (!modal || !closeButton) {
      return;
    }

    document.addEventListener('click', (event) => {
      const browseButton = event.target.closest('[data-action="browse-series"]');
      if (browseButton) {
        openModal(browseButton);
        return;
      }

      if (event.target.closest('[data-modal-close]')) {
        closeModal();
      }
    });

    modal.addEventListener('click', (event) => {
      if (event.target === modal) {
        closeModal();
      }
    });

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !modal.hidden) {
        event.preventDefault();
        closeModal();
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initialise, { once: true });
  } else {
    initialise();
  }
})();
