import * as vscode from 'vscode';
import * as symbolPicker from './symbolPicker';
import { GinkgoTestTreeDataProvider } from './ginkgoTestTreeDataProvider';
import { GinkgoOutliner } from './ginkgoOutliner';
import { CachingOutliner } from './cachingOutliner';
import { Commands } from './commands';
import { TestResult } from './testResult';
import { GinkgoRunTestCodeLensProvider } from './ginkgoRunTestCodelensProvider';
import { GinkgoNode } from './ginkgoNode';
import { GinkgoTest } from './ginkgoTest';

const extensionName = 'ginkgotestexplorer';
const displayName = 'Ginkgo Test Explorer';

// These are used when a property key is missing from settings, or its value is invalid.
const defaultGinkgoPath = 'ginkgo';
const defaultUpdateOn = 'onType';
const defaultUpdateOnTypeDelay = 1000;
const defaultDoubleClickThreshold = 400;
const defaultCacheTTL = 3600000;
const defaultEnableCodeLens = true;

const GO_MODE: vscode.DocumentFilter = { language: 'go', scheme: 'file' };

export function getConfiguration(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration(extensionName);
}

export function affectsConfiguration(evt: vscode.ConfigurationChangeEvent, name: string): boolean {
    return evt.affectsConfiguration(`${extensionName}.${name}`);
}

export let outputChannel: vscode.OutputChannel;

export class GinkgoTestExplorer {

    private cachingOutliner: CachingOutliner;
    private ginkgoTest: GinkgoTest;
    private ginkgoTestTreeDataProvider: GinkgoTestTreeDataProvider;
    private ginkgoTestCodeLensProvider: GinkgoRunTestCodeLensProvider;
    private outliner: GinkgoOutliner;

    readonly commands: Commands;
    constructor(context: vscode.ExtensionContext) {
        this.commands = new Commands();
        outputChannel = vscode.window.createOutputChannel(displayName);
        context.subscriptions.push(outputChannel);
        outputChannel.appendLine('Welcome to Ginkgo Explorer');

        const ginkgoPath = getConfiguration().get('ginkgoPath', defaultGinkgoPath);

        this.checkGinkgoIsInstalled(ginkgoPath);

        let cwd = "";
        if (vscode.workspace.workspaceFolders) {
            cwd = vscode.workspace.workspaceFolders[0].uri.fsPath;
        }
        this.ginkgoTest = new GinkgoTest(ginkgoPath, cwd, this.commands);
        context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(evt => {
            if (affectsConfiguration(evt, 'ginkgoPath')) {
                this.ginkgoTest.setGinkgoPath(getConfiguration().get('ginkgoPath', defaultGinkgoPath));
            }
        }));

        this.outliner = new GinkgoOutliner(ginkgoPath, this.commands);
        this.cachingOutliner = new CachingOutliner(this.outliner, getConfiguration().get('cacheTTL', defaultCacheTTL));
        context.subscriptions.push({ dispose: () => { this.cachingOutliner.clear(); } });
        context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(evt => {
            if (affectsConfiguration(evt, 'ginkgoPath')) {
                this.outliner.setGinkgoPath(getConfiguration().get('ginkgoPath', defaultGinkgoPath));
                this.cachingOutliner.setOutliner(this.outliner);
            }
            if (affectsConfiguration(evt, 'cacheTTL')) {
                this.cachingOutliner.setCacheTTL(getConfiguration().get('cacheTTL', defaultCacheTTL));
            }
        }));

        this.ginkgoTestTreeDataProvider = new GinkgoTestTreeDataProvider(context, this.commands, doc => this.cachingOutliner.fromDocument(doc), 'ginkgotestexplorer.clickTreeItem',
            getConfiguration().get('updateOn', defaultUpdateOn),
            getConfiguration().get('updateOnTypeDelay', defaultUpdateOnTypeDelay),
            getConfiguration().get('doubleClickThreshold', defaultDoubleClickThreshold),
        );
        context.subscriptions.push(vscode.window.registerTreeDataProvider('ginkgotestexplorer', this.ginkgoTestTreeDataProvider));
        context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(evt => {
            if (affectsConfiguration(evt, 'updateOn')) {
                this.ginkgoTestTreeDataProvider.setUpdateOn(getConfiguration().get('updateOn', defaultUpdateOn));
            }
            if (affectsConfiguration(evt, 'updateOnTypeDelay')) {
                this.ginkgoTestTreeDataProvider.setUpdateOnTypeDelay(getConfiguration().get('updateOnTypeDelay', defaultUpdateOnTypeDelay));
            }
            if (affectsConfiguration(evt, 'doubleClickThreshold')) {
                this.ginkgoTestTreeDataProvider.setDoubleClickThreshold(getConfiguration().get('doubleClickThreshold', defaultDoubleClickThreshold));
            }
        }));
        context.subscriptions.push(vscode.commands.registerCommand("ginkgotestexplorer.runTest.tree", this.onRunTest.bind(this)));

        this.ginkgoTestCodeLensProvider = new GinkgoRunTestCodeLensProvider(context, this.commands);
        this.ginkgoTestCodeLensProvider.setEnabled(getConfiguration().get('enableCodeLens', defaultEnableCodeLens));
        context.subscriptions.push(vscode.languages.registerCodeLensProvider(GO_MODE, this.ginkgoTestCodeLensProvider));
        context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(evt => {
            if (affectsConfiguration(evt, 'enableCodeLens')) {
                this.ginkgoTestCodeLensProvider.setEnabled(getConfiguration().get('enableCodeLens', defaultEnableCodeLens));
            }
        }));
        context.subscriptions.push(vscode.commands.registerCommand("ginkgotestexplorer.runTest.codelens", (args) => {
            if (args && args.testNode) {
                this.onRunTest(args.testNode);
            }
        }));

        context.subscriptions.push(vscode.commands.registerCommand('ginkgotestexplorer.generateCoverage', this.onGenerateCoverage.bind(this)));
        context.subscriptions.push(vscode.commands.registerCommand('ginkgotestexplorer.gotoSymbolInEditor', this.onGotoSymbolInEditor.bind(this)));
        context.subscriptions.push(vscode.commands.registerCommand("ginkgotestexplorer.runAllTest", this.onRunAllTests.bind(this)));
        context.subscriptions.push(vscode.commands.registerCommand("ginkgotestexplorer.showTestoutput", this.onShowTestOutput.bind(this)));
    }

    private async checkGinkgoIsInstalled(ginkgoPath: string) {
        const isInstalled = await this.ginkgoTest.checkGinkgoIsInstalled(ginkgoPath);
        if (!isInstalled) {
            outputChannel.appendLine(`Ginkgo not found.`);
            const action = await vscode.window.showInformationMessage('Would you like to install a Ginkgo and Gomega?', ...['Yes']);
            if (action === 'Yes') {
                outputChannel.show();
                outputChannel.appendLine('Installing Ginkgo and Gomega.');
                outputChannel.appendLine('go get github.com/onsi/ginkgo/ginkgo');
                outputChannel.appendLine('go get github.com/onsi/gomega/...');
                outputChannel.appendLine('Please wait...');
                let installed = await this.ginkgoTest.callGinkgoInstall();
                if (installed) {
                    outputChannel.appendLine('Ginkgo has been installed successfully.');
                    installed = await this.ginkgoTest.callGomegaInstall();
                    if (installed) {
                        outputChannel.appendLine('Gomega has been installed successfully.');
                    } else {
                        outputChannel.appendLine('Error installing Ginkgo and Gomega.');
                    }
                } else {
                    outputChannel.appendLine('Error installing Ginkgo and Gomega.');
                }
            }
        }
    }

    private async onShowTestOutput(testNode: GinkgoNode) {
        if (testNode.result && testNode.result.output && testNode.result.output.length > 0) {
            outputChannel.clear();
            outputChannel.show();
            outputChannel.appendLine("");
            outputChannel.appendLine("# " + testNode.key);
            outputChannel.appendLine("output:");
            outputChannel.appendLine(testNode.result.output);
        }
    }

    private async onRunTest(testNode: GinkgoNode) {
        this.ginkgoTestTreeDataProvider.prepareToRunTest(testNode);
        await this.ginkgoTest.runAllTest(testNode.key);
    }

    private async onRunAllTests(): Promise<TestResult[]> {
        if (this.ginkgoTestTreeDataProvider.rootNode) {
            this.ginkgoTestTreeDataProvider.prepareToRunTest(this.ginkgoTestTreeDataProvider.rootNode);
            return await this.ginkgoTest.runAllTest();
        }
        return [];
    }

    private async onGotoSymbolInEditor() {
        if (!vscode.window.activeTextEditor) {
            outputChannel.appendLine('Did not create the Go To Symbol menu: no active text editor');
            return;
        }
        try {
            await symbolPicker.fromTextEditor(vscode.window.activeTextEditor, doc => this.cachingOutliner.fromDocument(doc));
        } catch (err) {
            outputChannel.appendLine(`Could not create the Go To Symbol menu: ${err}`);
            const action = await vscode.window.showErrorMessage('Could not create the Go To Symbol menu', ...['Open Log']);
            if (action === 'Open Log') {
                outputChannel.show();
            }
        }
    }

    private async onGenerateCoverage() {
        outputChannel.clear();

        // TODO: Check if there was an error?
        await this.onRunAllTests();

        outputChannel.appendLine('Generating coverage results...');
        try {
            const output = this.ginkgoTest.generateCoverage();
            const viewPanel = vscode.window.createWebviewPanel('Coverage', 'Coverage results', { viewColumn: vscode.ViewColumn.Two, preserveFocus: true }, { enableScripts: true });
            viewPanel.webview.html = output;
        } catch (err) {
            outputChannel.appendLine(`Error while generating coverage: ${err}.`);
        }
    }

}