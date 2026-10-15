# Forge lineage workspace

## Goal
Developers can explore complete forge versions and inspect their exact code and collaboration state from one repository workspace.

## Problem
The current repository interface separates Code, Issues, Forks, Reviews, and Checks into tabs. The rendered local interface places version ancestry and exact-version actions below repeated cards. The user reports that the site does not look like a new Git system. Source evidence: apps/web/src/App.jsx and the previous ForksPanel.jsx version in Griz operation op_01a1286f7582703dabff8e5de965dd6f.

## Business rules
- Opening a repository from its list or command palette shall show the Forge workspace.
- The lineage graph shall connect each loaded version only to its recorded parents that are also loaded.
- Selecting a lineage version shall show that version's code commit, state commit, and collaboration records.
- Browsing code from the selected version shall open its exact code commit.
- A failed forge request shall show an error with a retry action.
- At viewport widths 390, 1024, and 1440 pixels, the Forge workspace shall keep horizontal graph scrolling inside its lineage region.

## Scenarios
### Repository opens in Forge
Given a repository with a published head and retained versions
When the developer opens it from the repository list or command palette
Then the Forge tab is selected and the lineage and selected-version inspector are visible

### Recorded ancestry
Given a root, two child forks, and a merge whose parents are the two forks
When the Forge workspace loads
Then the graph shows four parent-child connections and each version once

### Exact-version selection
Given two versions with different code commits, state commits, and collaboration records
When the developer selects the second version
Then the inspector shows the second version's commits and records without records from the first version

### Exact code navigation
Given a selected version with a code commit
When the developer chooses Browse exact code
Then the Code view opens with that code commit in its ref parameter

### Forge request failure
Given the forge endpoint returns an error
When the developer opens the Forge workspace
Then the error and Refresh action are visible and no lineage versions are fabricated

### Narrow workspace
Given a populated lineage with multiple depth columns
When the developer opens the Forge workspace at widths 390, 1024, and 1440 pixels
Then the graph scrolls inside its region without horizontal overflow of the document
