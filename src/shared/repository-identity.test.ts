import {describe,expect,it} from "vitest";
import {readFileSync} from "node:fs";

function projectFile(path:string):string{
  return readFileSync(new URL("../../"+path,import.meta.url),"utf8");
}

describe("REPO-RENAME-001: Study Anchor repository identity",()=>{
  it("keeps the package root name consistent with the lockfile for npm ci",()=>{
    const pkg=JSON.parse(projectFile("package.json")) as {name:string};
    const lock=JSON.parse(projectFile("package-lock.json")) as {
      name:string;packages:{"":{name:string}};
    };
    expect(pkg.name).toBe("study-anchor");
    expect(lock.name).toBe(pkg.name);
    expect(lock.packages[""].name).toBe(pkg.name);
  });

  it("uses Study Anchor consistently in user-facing desktop and W2 UI",()=>{
    expect(projectFile("src/renderer/index.html")).toContain("<title>Study Anchor</title>");
    const app=projectFile("src/renderer/src/App.tsx");
    expect(app).toContain("<strong>Study Anchor</strong>");
    expect(app).toContain("<footer>Study Anchor · Local-first by design");
    const prototype=projectFile("prototypes/w2-hybrid-workspace/index.html");
    expect(prototype).toContain("<title>Study Anchor ·");
    expect(prototype).toContain("<small>ANCHOR</small>");
  });

  it("preserves OS install identity and all legacy data-path compatibility",()=>{
    const pkg=JSON.parse(projectFile("package.json")) as {
      build:{appId:string;productName:string};
    };
    // Changes here require a separate backward-compatible data migration and GUI test.
    expect(pkg.build.appId).toBe("org.agenttoentrepreneurship.desktop");
    expect(pkg.build.productName).toBe("Agent to Entrepreneurship");
    const main=projectFile("src/main/index.ts");
    expect(main).toContain("process.env.ATE_USER_DATA_DIR");
    expect(main).toContain("ate-local.sqlite");
    expect(main).toContain("ate-shared-history.sqlite");
  });

  it("points current repo setup and governance to the renamed remote",()=>{
    const readme=projectFile("README.md");
    const governance=projectFile("docs/w4/08_GITHUB_GOVERNANCE.md");
    expect(readme).toContain("https://github.com/yanpr1332/study-anchor.git");
    expect(governance).toContain("https://github.com/yanpr1332/study-anchor/settings/branches");
    expect(readme).not.toContain("cd /path/to/Agent-to-Entrepreneurship");
    expect(governance).not.toContain("https://github.com/yanpr1332/Agent-to-Entrepreneurship");
  });
});
