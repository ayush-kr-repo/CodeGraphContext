import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { CgcService } from "./service";
import { SidebarControlPanel } from "../views/controlPanel";

export class ContextManager {
  private lastRecommendedPath?: string;

  constructor(
    private readonly service: CgcService,
    private readonly sidebar: SidebarControlPanel
  ) {}

  public async initializeContext(): Promise<void> {
    const config = vscode.workspace.getConfiguration("cgc");
    const mode = config.get<string>("contextMode", "global");

    switch (mode) {
      case "global":
        await this.handleGlobalMode();
        break;
      case "named":
        await this.handleNamedMode();
        break;
      case "per-repo":
        await this.handlePerRepoMode();
        break;
    }
  }

  private async handleGlobalMode(): Promise<void> {
    // In global mode, we don't override the repo path automatically
    // The service will use the global database by default
    await this.service.switchContext("global");
    await this.sidebar.refresh();
  }

  private async handleNamedMode(): Promise<void> {
    const activeContext = vscode.workspace.getConfiguration("cgc").get<string>("repoPath", "");
    if (!activeContext) {
      // Don't load anything, wait for user selection in sidebar
      return;
    }
    await this.service.switchContext(activeContext);
    await this.sidebar.refresh();
  }

  private async handlePerRepoMode(): Promise<void> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders?.length) return;

    const rootPath = workspaceFolders[0].uri.fsPath;

    // Tier 1: Immediate Match
    const rootCgcPath = path.join(rootPath, ".codegraphcontext");
    if (fs.existsSync(rootCgcPath)) {
      await vscode.workspace.getConfiguration("cgc").update("repoPath", rootPath, vscode.ConfigurationTarget.Workspace);
      await this.service.switchContext(rootPath);
      await this.sidebar.refresh();
      return;
    }

    // Tier 2: Deep Child Discovery
    const matches = await vscode.workspace.findFiles("**/.codegraphcontext/metadata.json", "**/node_modules/**", 10);
    if (matches.length > 0) {
      // Find the first one that isn't the root (which we already checked)
      const bestMatchUri = matches.find(m => path.dirname(m.fsPath) !== rootCgcPath);
      if (bestMatchUri) {
        const bestMatchPath = path.dirname(path.dirname(bestMatchUri.fsPath));
        this.lastRecommendedPath = bestMatchPath;
        
        // Non-blocking notification
        vscode.window.showInformationMessage(
          `CGC: Found a local context in '${path.basename(bestMatchPath)}'. Would you like to connect?`,
          "Connect", "Ignore"
        ).then(async (choice) => {
          if (choice === "Connect") {
            await vscode.workspace.getConfiguration("cgc").update("repoPath", bestMatchPath, vscode.ConfigurationTarget.Workspace);
            await this.service.switchContext(bestMatchPath);
            await this.sidebar.refresh();
          }
        });
      }
    }
  }

  public getRecommendedPath(): string | undefined {
    return this.lastRecommendedPath;
  }
}
