import './appDialog.css';

export interface AppDialogOptions {
  message: string;
  detail?: string;
  buttons: string[];
  cancelId: number;
}

/** 共用應用程式對話框:文字一律用 textContent,保留焦點與鍵盤取消。 */
export function appDialog(options: AppDialogOptions): Promise<number> {
  return new Promise((resolve) => {
    const previous = document.activeElement;
    const dialog = document.createElement('dialog');
    dialog.className = 'app-dialog';
    const title = document.createElement('h2');
    title.textContent = options.message;
    dialog.setAttribute('aria-label', options.message);
    dialog.append(title);
    if (options.detail) {
      const detail = document.createElement('p');
      detail.textContent = options.detail;
      dialog.append(detail);
    }
    const actions = document.createElement('div');
    actions.className = 'app-dialog-actions';
    const finish = (result: number): void => {
      dialog.close();
      dialog.remove();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
      resolve(result);
    };
    options.buttons.forEach((label, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      button.className = index === options.cancelId ? 'cancel' : 'primary';
      button.autofocus = index === options.cancelId;
      button.addEventListener('click', () => finish(index));
      actions.append(button);
    });
    dialog.append(actions);
    dialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      finish(options.cancelId);
    });
    document.body.append(dialog);
    dialog.showModal();
  });
}
