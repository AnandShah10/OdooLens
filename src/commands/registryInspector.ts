import * as vscode from 'vscode';
import { OdooWorkspaceIndex } from '../index/OdooIndex';
import { JsonRpcRuntimeProvider, OdooRuntimeProvider } from '../runtime/protocol/OdooRuntimeProvider';

const SECRET_KEY = 'odooIntelligence.runtimeToken';

export function registerRuntimeCommands(context: vscode.ExtensionContext, index: OdooWorkspaceIndex): void {
  const provider: OdooRuntimeProvider = new JsonRpcRuntimeProvider();

  context.subscriptions.push(
    vscode.commands.registerCommand('odooIntelligence.connectRuntime', async () => {
      if (!vscode.workspace.getConfiguration('odooIntelligence').get<boolean>('enableRuntimeRegistry', false)) {
        vscode.window.showInformationMessage(
          'OdooLens: the runtime registry is disabled (odooIntelligence.enableRuntimeRegistry). Enable it in settings to connect to a live Odoo server.'
        );
        return;
      }
      const serverUrl = await vscode.window.showInputBox({ prompt: 'Odoo server URL', placeHolder: 'https://my-odoo.example.com' });
      if (!serverUrl) return;
      const database = await vscode.window.showInputBox({ prompt: 'Database name' });
      if (!database) return;
      const token = await vscode.window.showInputBox({ prompt: 'Auth token / API key', password: true });
      if (!token) return;

      await context.secrets.store(SECRET_KEY, token);
      try {
        await provider.connect({ serverUrl, database, authTokenSecretKey: SECRET_KEY }, token);
        await provider.getModels(); // eager health check
        vscode.window.showInformationMessage('OdooLens: connected to runtime registry.');
      } catch (err: any) {
        vscode.window.showErrorMessage(
          `OdooLens: could not reach the runtime helper endpoint (${String(err?.message ?? err)}). ` +
            `The extension continues to work fully from the static index without a runtime connection.`
        );
      }
    }),

    vscode.commands.registerCommand('odooIntelligence.inspectRuntimeRegistry', async () => {
      const modelNames = Array.from(index.models.keys()).sort();
      const model = await vscode.window.showQuickPick(modelNames, { placeHolder: 'Select a model to inspect' });
      if (!model) return;
      const staticModel = index.getModel(model);

      const runtimeEnabled = vscode.workspace.getConfiguration('odooIntelligence').get<boolean>('enableRuntimeRegistry', false);
      let runtimeInfo = null;
      let runtimeError: string | null = null;
      if (runtimeEnabled && provider.isConnected()) {
        try {
          runtimeInfo = await provider.getModel(model);
        } catch (err: any) {
          runtimeError = String(err?.message ?? err);
        }
      }

      const panel = vscode.window.createWebviewPanel('odooRuntime', `Registry: ${model}`, vscode.ViewColumn.Beside, {
        enableScripts: false,
      });
      panel.webview.html = `<!doctype html><html><body style="font-family:var(--vscode-font-family);padding:1em;">
        <h2>${model}</h2>
        <h3>STATIC INDEX</h3>
        <p>${staticModel ? `${staticModel.fields.size} field(s), ${staticModel.methods.size} method(s), across modules: ${Array.from(staticModel.modules).join(', ')}` : '<i>not found in static index</i>'}</p>
        <h3>RUNTIME REGISTRY</h3>
        ${
          !runtimeEnabled
            ? `<p><i>Disabled via odooIntelligence.enableRuntimeRegistry. Enable it in settings, then run "Odoo: Connect to Runtime" to compare against a live server.</i></p>`
            : !provider.isConnected()
            ? `<p><i>Not connected. Run "Odoo: Connect to Runtime" to compare against a live server. The extension works fully without this.</i></p>`
            : runtimeError
            ? `<p style="color:var(--vscode-errorForeground)">Runtime call failed: ${runtimeError}</p>`
            : runtimeInfo
            ? `<p>${runtimeInfo.fields.length} field(s), ${runtimeInfo.methods.length} method(s) reported live. Inherited by: ${runtimeInfo.inheritedModules.join(', ')}</p>`
            : `<p><i>Model not present in the live registry.</i></p>`
        }
        <p><i>When both sources are available, runtime facts should be treated as authoritative for "does this exist right now", while the static index remains authoritative for "where is this defined in source".</i></p>
      </body></html>`;
    })
  );
}
