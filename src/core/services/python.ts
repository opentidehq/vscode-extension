// The interpreter the Python Environments or Python extension picked, when either is installed.
// No extensionDependencies: forks without them use .venv and PATH. APIs are typed here, minimally.
import * as vscode from "vscode";

interface PythonEnvironmentsApi {
  getEnvironment(
    scope: vscode.Uri | undefined,
  ): Promise<{ execInfo?: { run?: { executable?: string } }; environmentPath?: vscode.Uri } | undefined>;
  onDidChangeEnvironment?: vscode.Event<unknown>;
}

interface PythonExtensionApi {
  environments?: {
    getActiveEnvironmentPath(resource?: vscode.Uri): { path: string } | undefined;
    resolveEnvironment(path: string): Promise<{ executable?: { uri?: vscode.Uri } } | undefined>;
    onDidChangeActiveEnvironmentPath?: vscode.Event<unknown>;
  };
}

export const PYTHON_ENVIRONMENTS_ID = "ms-python.vscode-python-envs";
export const PYTHON_EXTENSION_ID = "ms-python.python";

async function activate<T>(id: string): Promise<T | undefined> {
  const extension = vscode.extensions.getExtension<T>(id);
  if (!extension) return undefined;
  try {
    return extension.isActive ? extension.exports : await extension.activate();
  } catch {
    return undefined;
  }
}

export async function pythonEnvironmentsInterpreter(
  folder: vscode.Uri | undefined,
): Promise<string | undefined> {
  const api = await activate<PythonEnvironmentsApi>(PYTHON_ENVIRONMENTS_ID);
  if (typeof api?.getEnvironment !== "function") return undefined;
  const environment = await api.getEnvironment(folder);
  return environment?.execInfo?.run?.executable;
}

export async function pythonExtensionInterpreter(
  folder: vscode.Uri | undefined,
): Promise<string | undefined> {
  const api = await activate<PythonExtensionApi>(PYTHON_EXTENSION_ID);
  const environments = api?.environments;
  if (!environments) return undefined;
  const active = environments.getActiveEnvironmentPath(folder);
  if (!active?.path) return undefined;
  const resolved = await environments.resolveEnvironment(active.path);
  return resolved?.executable?.uri?.fsPath ?? active.path;
}

/** Fire `listener` when either extension changes the selected environment. Only subscribes when installed. */
export async function onDidChangePythonEnvironment(listener: () => void): Promise<vscode.Disposable> {
  const disposables: vscode.Disposable[] = [];
  if (vscode.extensions.getExtension(PYTHON_ENVIRONMENTS_ID)) {
    const api = await activate<PythonEnvironmentsApi>(PYTHON_ENVIRONMENTS_ID);
    if (api?.onDidChangeEnvironment) disposables.push(api.onDidChangeEnvironment(listener));
  }
  if (vscode.extensions.getExtension(PYTHON_EXTENSION_ID)) {
    const api = await activate<PythonExtensionApi>(PYTHON_EXTENSION_ID);
    const event = api?.environments?.onDidChangeActiveEnvironmentPath;
    if (event) disposables.push(event(listener));
  }
  return vscode.Disposable.from(...disposables);
}
