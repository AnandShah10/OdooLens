import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';

const FIXTURES_ROOT = path.resolve(__dirname, '../../../tests/fixtures/basic_odoo');

suite('OdooLens Extension Host Integration', () => {
  test('extension activates on a workspace containing __manifest__.py files', async () => {
    const ext = vscode.extensions.getExtension('AnandShah.odoolens');
    assert.ok(ext, 'extension should be discoverable by its publisher.name id');
    await ext!.activate();
    assert.strictEqual(ext!.isActive, true);
  });

  test('Odoo: Rebuild Index command is registered and completes without throwing', async () => {
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes('odooIntelligence.rebuildIndex'));
    await vscode.commands.executeCommand('odooIntelligence.rebuildIndex');
  });

  test('all commands declared in package.json are registered', async () => {
    const pkg = require(path.resolve(__dirname, '../../../package.json'));
    const declared: string[] = pkg.contributes.commands.map((c: { command: string }) => c.command);
    const registered = await vscode.commands.getCommands(true);
    for (const cmd of declared) {
      assert.ok(registered.includes(cmd), `expected command "${cmd}" to be registered`);
    }
  });

  test('hover over a known field returns Odoo field intelligence', async () => {
    const filePath = path.join(FIXTURES_ROOT, 'base_module/models/sale_order.py');
    const doc = await vscode.workspace.openTextDocument(filePath);
    await vscode.window.showTextDocument(doc);
    await vscode.commands.executeCommand('odooIntelligence.rebuildIndex');

    const text = doc.getText();
    const lineIdx = text.split('\n').findIndex((l) => l.includes("order.amount_total = sum"));
    assert.ok(lineIdx >= 0, 'fixture line not found — has the fixture file changed?');
    const col = text.split('\n')[lineIdx].indexOf('amount_total', text.split('\n')[lineIdx].indexOf('order.') + 6);
    const position = new vscode.Position(lineIdx, col + 1);

    const hovers = (await vscode.commands.executeCommand(
      'vscode.executeHoverProvider',
      doc.uri,
      position
    )) as vscode.Hover[];

    assert.ok(hovers.length > 0, 'expected at least one hover result for a known compute field');
    const combined = hovers.map((h) => h.contents.map((c) => (typeof c === 'string' ? c : (c as vscode.MarkdownString).value)).join('\n')).join('\n');
    assert.match(combined, /amount_total/);
    assert.match(combined, /Computed by/);
  });

  test('completion after self.env[\'sale.order\']. offers known fields', async () => {
    const filePath = path.join(FIXTURES_ROOT, 'base_module/models/sale_order.py');
    const doc = await vscode.workspace.openTextDocument(filePath);
    await vscode.window.showTextDocument(doc);
    await vscode.commands.executeCommand('odooIntelligence.rebuildIndex');

    const snippet = "\n        self.env['sale.order'].";
    const edit = new vscode.WorkspaceEdit();
    const endPos = doc.lineAt(doc.lineCount - 1).range.end;
    edit.insert(doc.uri, endPos, snippet);
    await vscode.workspace.applyEdit(edit);

    const lastLine = doc.lineCount - 1;
    const position = new vscode.Position(lastLine, doc.lineAt(lastLine).text.length);

    const list = (await vscode.commands.executeCommand(
      'vscode.executeCompletionItemProvider',
      doc.uri,
      position
    )) as vscode.CompletionList;

    const labels = list.items.map((i) => (typeof i.label === 'string' ? i.label : i.label.label));
    assert.ok(labels.includes('partner_id'), `expected partner_id in completion items, got: ${labels.join(', ')}`);
  });

  test('rename on a field declaration renames it across every declaring module and its XML usages', async () => {
    const saleOrderFile = path.join(FIXTURES_ROOT, 'sale_extension/models/sale_order.py');
    const doc = await vscode.workspace.openTextDocument(saleOrderFile);
    await vscode.window.showTextDocument(doc);
    await vscode.commands.executeCommand('odooIntelligence.rebuildIndex');

    const text = doc.getText();
    const lineIdx = text.split('\n').findIndex((l) => l.includes('priority = fields.Char'));
    assert.ok(lineIdx >= 0, 'fixture line not found — has sale_extension/models/sale_order.py changed?');
    const position = new vscode.Position(lineIdx, 4); // inside the `priority` identifier

    const workspaceEdit = (await vscode.commands.executeCommand(
      'vscode.executeDocumentRenameProvider',
      doc.uri,
      position,
      'urgency_level'
    )) as vscode.WorkspaceEdit;

    assert.ok(workspaceEdit, 'expected a WorkspaceEdit from the rename provider');
    const entries = workspaceEdit.entries();
    assert.ok(entries.length >= 2, `expected at least a Python declaration edit and an XML edit, got ${entries.length}`);

    const touchesXmlView = entries.some(([uri]) => uri.fsPath.includes('sale_extension') && uri.fsPath.endsWith('.xml'));
    assert.ok(touchesXmlView, 'expected the rename to also touch the XML view that references <field name="priority"/>');
  });

  test('rename on a method declaration renames every override and its XML button reference', async () => {
    const saleOrderFile = path.join(FIXTURES_ROOT, 'base_module/models/sale_order.py');
    const doc = await vscode.workspace.openTextDocument(saleOrderFile);
    await vscode.window.showTextDocument(doc);
    await vscode.commands.executeCommand('odooIntelligence.rebuildIndex');

    const text = doc.getText();
    const lineIdx = text.split('\n').findIndex((l) => l.includes('def action_confirm'));
    assert.ok(lineIdx >= 0, 'fixture line not found — has base_module/models/sale_order.py changed?');
    const position = new vscode.Position(lineIdx, text.split('\n')[lineIdx].indexOf('action_confirm') + 1);

    const workspaceEdit = (await vscode.commands.executeCommand(
      'vscode.executeDocumentRenameProvider',
      doc.uri,
      position,
      'action_validate'
    )) as vscode.WorkspaceEdit;

    assert.ok(workspaceEdit, 'expected a WorkspaceEdit from the rename provider');
    const entries = workspaceEdit.entries();
    // base_module's own def, sale_extension's override, and the XML button reference.
    assert.ok(entries.length >= 3, `expected at least 3 edited files, got ${entries.length}`);
    const touchesSaleExtension = entries.some(([uri]) => uri.fsPath.includes('sale_extension') && uri.fsPath.endsWith('.py'));
    assert.ok(touchesSaleExtension, "expected sale_extension's action_confirm override to be renamed too");
    const touchesXmlButton = entries.some(([uri]) => uri.fsPath.endsWith('.xml'));
    assert.ok(touchesXmlButton, 'expected the <button name="action_confirm"> reference to be renamed too');
  });

  test('rename on a model _name declaration renames every _inherit and self.env[...] reference', async () => {
    const saleOrderFile = path.join(FIXTURES_ROOT, 'base_module/models/sale_order.py');
    const doc = await vscode.workspace.openTextDocument(saleOrderFile);
    await vscode.window.showTextDocument(doc);
    await vscode.commands.executeCommand('odooIntelligence.rebuildIndex');

    const text = doc.getText();
    const lineIdx = text.split('\n').findIndex((l) => l.includes('_name = "sale.order"'));
    assert.ok(lineIdx >= 0, 'fixture line not found — has base_module/models/sale_order.py changed?');
    const position = new vscode.Position(lineIdx, text.split('\n')[lineIdx].indexOf('sale.order') + 1);

    const workspaceEdit = (await vscode.commands.executeCommand(
      'vscode.executeDocumentRenameProvider',
      doc.uri,
      position,
      'sale.confirmed_order'
    )) as vscode.WorkspaceEdit;

    assert.ok(workspaceEdit, 'expected a WorkspaceEdit from the rename provider');
    const entries = workspaceEdit.entries();
    // base_module's _name, sale_extension's + custom_sale's _inherit, and every self.env[...] usage.
    assert.ok(entries.length >= 3, `expected at least 3 edited files, got ${entries.length}`);
    const touchesSaleExtension = entries.some(([uri]) => uri.fsPath.includes('sale_extension') && uri.fsPath.endsWith('.py'));
    assert.ok(touchesSaleExtension, "expected sale_extension's _inherit = \"sale.order\" to be renamed too");
  });
});
