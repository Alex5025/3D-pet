import { app } from 'electron';
import { configureCliEnvironment } from './cliEnvironment';
import { runAgentSelftest, runAgyE2E, runClaudeE2E, runCodexE2E } from './agent/selftest';
import { appPrompt } from './appPrompt';
import { createCharacters, type Characters } from './characters';
import { createChat, type Chat } from './chat';
import { createControl, type Control } from './control';
import { createDrop, type Drop } from './drop';
import { createIpcChat, type IpcChat } from './ipc/chat';
import { createIpcControl, type IpcControl } from './ipc/control';
import { createIpcMenu, type IpcMenu } from './ipc/menu';
import { createIpcOverlay, type IpcOverlay } from './ipc/overlay';
import { createIpcPets, type IpcPets } from './ipc/pets';
import { createIpcReferences, type IpcReferences } from './ipc/references';
import { createIpcSettings, type IpcSettings } from './ipc/settings';
import { createLifecycle, type Lifecycle } from './lifecycle';
import { createMotions, type Motions } from './motions';
import { configureDataPaths, createPaths, type Paths } from './paths';
import { createPetHouse } from './petHouse';
import { createPower, type Power } from './power';
import { createReferences, type References } from './references';
import { createTray, type TrayService } from './tray';
import { createWindows, type Windows } from './windows';

configureCliEnvironment();
configureDataPaths();
if (!app.requestSingleInstanceLock()) app.exit(0);

const paths: Paths = createPaths({
  get characters() { return characters.characters; },
  get getPet() { return characters.getPet; },
});
const characters: Characters = createCharacters({
  get runtimeDataDir() { return paths.runtimeDataDir; },
  get history() { return paths.history; },
  get settingsWin() { return windows.settingsWin; },
  get sendRefFiles() { return references.sendRefFiles; },
  get defaultVrmPath() { return paths.defaultVrmPath; },
  get modelsDir() { return paths.modelsDir; },
  get clearChatQueue() { return chat.clearChatQueue; },
  get bridge() { return chat.bridge; },
  get dispatchAll() { return chat.dispatchAll; },
  get refreshCursorPoll() { return power.refreshCursorPoll; },
  get scheduleIdleMotion() { return motions.scheduleIdleMotion; },
  get win() { return windows.win; },
  get controlWin() { return windows.controlWin; },
  get scheduleControlStatus() { return control.scheduleControlStatus; },
  get refreshTray() { return tray.refreshTray; },
  get clearTranscript() { return chat.clearTranscript; },
  get cancelIdleMotion() { return motions.cancelIdleMotion; },
});
const windows: Windows = createWindows({
  get selectPet() { return characters.selectPet; },
  get registry() { return characters.registry; },
});
const petHouse = createPetHouse({
  get overlay() { return windows.win; },
  get getPet() { return characters.getPet; },
  get defaultVrmPath() { return paths.defaultVrmPath; },
  refresh: () => tray.refreshTray(),
});
const tray: TrayService = createTray({
  housePet: () => petHouse.petId,
  toggleHouse: (id) => petHouse.toggle(id),
  get registry() { return characters.registry; },
  get getPet() { return characters.getPet; },
  get pets() { return characters.pets; },
  get selectPet() { return characters.selectPet; },
  get chooseVrm() { return characters.chooseVrm; },
  get motionMenuItems() { return motions.motionMenuItems; },
  get defaultPoseMenuItems() { return motions.defaultPoseMenuItems; },
  get win() { return windows.win; },
  get openSettings() { return windows.openSettings; },
  get openControlPanel() { return windows.openControlPanel; },
  get resetState() { return characters.resetState; },
  get restartPet() { return characters.restartPet; },
  get setPetEnabled() { return characters.setPetEnabled; },
  get serializeCharacter() { return characters.serializeCharacter; },
  get createNewPet() { return characters.createNewPet; },
  get restartApp() { return lifecycle.restartApp; },
  get shutdownSync() { return lifecycle.shutdownSync; },
});
const chat: Chat = createChat({
  get win() { return windows.win; },
  get history() { return paths.history; },
  get getPet() { return characters.getPet; },
  get finishLedgerTask() { return control.finishLedgerTask; },
  get scheduleControlStatus() { return control.scheduleControlStatus; },
  get pets() { return characters.pets; },
  get taskLedger() { return control.taskLedger; },
  get runningTaskByPet() { return control.runningTaskByPet; },
  get motionFiles() { return motions.motionFiles; },
  get motionsDir() { return paths.motionsDir; },
  get projectFor() { return characters.projectFor; },
  get petRefFiles() { return references.petRefFiles; },
  get refKey() { return references.refKey; },
  get scheduleConfigFlush() { return characters.scheduleConfigFlush; },
});
const motions: Motions = createMotions({
  get motionsDir() { return paths.motionsDir; },
  get pets() { return characters.pets; },
  get isIdleMotionPaused() { return power.isIdleMotionPaused; },
  get win() { return windows.win; },
  get updatePet() { return characters.updatePet; },
  get refreshTray() { return tray.refreshTray; },
  get sendPetProfiles() { return characters.sendPetProfiles; },
  get getPet() { return characters.getPet; },
});
const drop: Drop = createDrop({
  get pets() { return characters.pets; },
  get overlayBounds() { return power.overlayBounds; },
  get win() { return windows.win; },
  get powerTier() { return power.powerTier; },
});
const lifecycle: Lifecycle = createLifecycle({
  stopBackground: () => {
    petHouse.dispose();
    for (const service of [ipcOverlay, ipcPets, ipcReferences, ipcChat, ipcSettings, ipcControl, ipcMenu, power, drop, motions, control, tray]) service.dispose();
  },
  stopAgents: () => chat.dispose(),
  closeWindows: () => { paths.dispose(); windows.dispose(); },
  get persistConfigSync() { return characters.persistConfigSync; },
  get pets() { return characters.pets; },
});
const control: Control = createControl({
  get bridge() { return chat.bridge; },
  get pets() { return characters.pets; },
  get chatQueue() { return chat.chatQueue; },
  get controlWin() { return windows.controlWin; },
});
const ipcOverlay: IpcOverlay = createIpcOverlay({
  get win() { return windows.win; },
  get setInteractive() { return windows.setInteractive; },
  get syncOverlayMouseEvents() { return windows.syncOverlayMouseEvents; },
  get setInputMode() { return windows.setInputMode; },
});
const ipcPets: IpcPets = createIpcPets({
  get win() { return windows.win; },
  get settingsWin() { return windows.settingsWin; },
  get controlWin() { return windows.controlWin; },
  get pets() { return characters.pets; },
  get registry() { return characters.registry; },
  get getPet() { return characters.getPet; },
  get bridge() { return chat.bridge; },
  get updatePet() { return characters.updatePet; },
  get setPetEnabled() { return characters.setPetEnabled; },
  get serializeCharacter() { return characters.serializeCharacter; },
  get createNewPet() { return characters.createNewPet; },
  get removePet() { return characters.removePet; },
  get selectPet() { return characters.selectPet; },
  get sendPetProfiles() { return characters.sendPetProfiles; },
  get avatarIcons() { return characters.avatarIcons; },
  get wardrobeLists() { return characters.wardrobeLists; },
  get motionsDir() { return paths.motionsDir; },
  get defaultVrmPath() { return paths.defaultVrmPath; },
});
const references: References = createReferences({
  get getPet() { return characters.getPet; },
  get win() { return windows.win; },
  get pushVrm() { return characters.pushVrm; },
});
const ipcReferences: IpcReferences = createIpcReferences({
  get dropWindows() { return drop.dropWindows; },
  get win() { return windows.win; },
  get pets() { return characters.pets; },
  get addReferencePaths() { return references.addReferencePaths; },
  get petRefFiles() { return references.petRefFiles; },
  get refKey() { return references.refKey; },
  get sendRefFiles() { return references.sendRefFiles; },
});
const ipcChat: IpcChat = createIpcChat({
  get newSession() { return characters.newSession; },
  get win() { return windows.win; },
  get pets() { return characters.pets; },
  get projectFor() { return characters.projectFor; },
  get getPet() { return characters.getPet; },
  get chatKey() { return chat.chatKey; },
  get chatRevisions() { return chat.chatRevisions; },
  get bridge() { return chat.bridge; },
  get liveTranscripts() { return chat.liveTranscripts; },
  get completedTranscripts() { return chat.completedTranscripts; },
  get history() { return paths.history; },
  get settingsWin() { return windows.settingsWin; },
  get controlWin() { return windows.controlWin; },
  get petRefFiles() { return references.petRefFiles; },
  get refKey() { return references.refKey; },
  get sendRefFiles() { return references.sendRefFiles; },
  get chatQueue() { return chat.chatQueue; },
  get clearTranscript() { return chat.clearTranscript; },
  get updatePet() { return characters.updatePet; },
  get sendPetProfiles() { return characters.sendPetProfiles; },
  get chatDispatcher() { return chat.chatDispatcher; },
  get markLedgerRemoved() { return control.markLedgerRemoved; },
});
const ipcSettings: IpcSettings = createIpcSettings({
  get win() { return windows.win; },
  get settingsWin() { return windows.settingsWin; },
  get controlWin() { return windows.controlWin; },
  get refreshTray() { return tray.refreshTray; },
  get tray() { return tray.tray; },
  get persistConfigSync() { return characters.persistConfigSync; },
  get storageError() { return characters.storageError; },
  get pets() { return characters.pets; },
  get serializeCharacter() { return characters.serializeCharacter; },
  get getPet() { return characters.getPet; },
  get characters() { return characters.characters; },
  get reportStorageError() { return characters.reportStorageError; },
  get scheduleIdleMotion() { return motions.scheduleIdleMotion; },
  get sendPetProfiles() { return characters.sendPetProfiles; },
  get chooseVrm() { return characters.chooseVrm; },
  get selectProject() { return characters.selectProject; },
  get chooseWorkspace() { return characters.chooseWorkspace; },
  get workspaceRoot() { return characters.workspaceRoot; },
  get registry() { return characters.registry; },
  get scheduleConfigFlush() { return characters.scheduleConfigFlush; },
  get bridge() { return chat.bridge; },
  get refreshMotions() { return motions.refreshMotions; },
  get motionFiles() { return motions.motionFiles; },
  get setDefaultPose() { return motions.setDefaultPose; },
});
const ipcControl: IpcControl = createIpcControl({
  get controlWin() { return windows.controlWin; },
  get pets() { return characters.pets; },
  get chatQueue() { return chat.chatQueue; },
  get getPet() { return characters.getPet; },
  get ledgerSummary() { return control.ledgerSummary; },
  get taskLedger() { return control.taskLedger; },
  get chatDispatcher() { return chat.chatDispatcher; },
  get scheduleControlStatus() { return control.scheduleControlStatus; },
  get buildControlStatus() { return control.buildControlStatus; },
  get markLedgerRemoved() { return control.markLedgerRemoved; },
  get win() { return windows.win; },
  get restartApp() { return lifecycle.restartApp; },
  get shutdownSync() { return lifecycle.shutdownSync; },
});
const ipcMenu: IpcMenu = createIpcMenu({
  get win() { return windows.win; },
  get pets() { return characters.pets; },
  get selectPet() { return characters.selectPet; },
  get refreshMotions() { return motions.refreshMotions; },
  get petMenu() { return tray.petMenu; },
  get motionFiles() { return motions.motionFiles; },
  get motionsDir() { return paths.motionsDir; },
  get openSettings() { return windows.openSettings; },
  get openControlPanel() { return windows.openControlPanel; },
  get resetState() { return characters.resetState; },
  get restartPet() { return characters.restartPet; },
});
const power: Power = createPower({
  get win() { return windows.win; },
  get pets() { return characters.pets; },
  get dragMonitor() { return drop.dragMonitor; },
});

app.whenReady().then(async () => {
  paths.writeSystemPidRecord();
  const selftestMode = process.env['VRM_PET_AGENT_SELFTEST'];
  if (selftestMode) {
    const pass = selftestMode === 'claude' ? await runClaudeE2E()
      : selftestMode === 'codex' ? await runCodexE2E()
        : selftestMode === 'agy' ? await runAgyE2E() : await runAgentSelftest();
    app.exit(pass ? 0 : 1);
    return;
  }
  if (process.platform === 'darwin') app.dock?.hide();
  try {
    paths.start();
    characters.prepareStore();
    await paths.ensureDefaultVrm();
    await characters.loadConfig();
  } catch (error) {
    await appPrompt({ message: `設定初始化失敗，原檔已保留：${String(error)}`, buttons: ['結束'], cancelId: 0 });
    app.exit(1);
    return;
  }
  await characters.initializeCharacters();
  await chat.start();
  await motions.start();
  windows.createOverlay();
  petHouse.start();
  await ipcOverlay.start();
  await ipcPets.start();
  await ipcReferences.start();
  await ipcChat.start();
  await ipcSettings.start();
  await ipcControl.start();
  await ipcMenu.start();
  await power.start();
  await drop.start();
  power.refreshCursorPoll();
  await tray.start();
  const unresolved = [...characters.pets.values()].find(profile => profile.characterError);
  if (unresolved) windows.openSettings('char', unresolved.id);
});

app.on('second-instance', () => windows.openControlPanel());
lifecycle.start();
