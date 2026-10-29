import { appDialog, type AppDialogOptions } from './appDialog';
const options = JSON.parse(new URLSearchParams(location.search).get('options')!) as AppDialogOptions;
void appDialog(options).then((response) => window.pet.respondToPrompt(response));
