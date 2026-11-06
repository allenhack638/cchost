---
version: 1
slug: "lib-ui-page-html"
primary_target: "lib/ui/page.html"
related_targets: []
---

# cchost ui — surface brief

Scope: the single page served by `cchost ui` (lib/ui/page.html). Mode: Operate. Audience and job: developers with 2+ Claude Code accounts managing every profile, its 7 shared resources, endpoints and doctor from one page, previewing every change before it happens. Constraints: zero dependencies, system fonts only (local tool, no network), light and dark, keyboard operable, tokens never on the page.

## Direction contract

THESIS: The category standard, executed at Vercel/Linear craft: a calm admin dashboard where the setup is readable at a glance and every change is previewed, then reported. It refuses dashboard filler: no stat cards, no charts, no hero.

OWN-WORLD: White and near-white neutral surfaces (dark: near-black zinc), 1px hairline borders, 8px radii, one blue primary for actions and selection; state colours only where they mean something (green shared, amber private, grey missing, red danger). System sans at a 13/14px base with tabular figures; monospace only for paths.

STORY: The user sees all profiles and what each shares, picks a profile, chooses an action, reads the exact per-resource preview, applies it, and watches the activity log confirm each step.

FIRST VIEWPORT: Left sidebar (240px): cchost wordmark; Profiles, Shared pool, Doctor, Activity; pool path and theme at the bottom. Main: header "Profiles" with the Add profile primary button, a one-line legend, then a responsive grid of profile cards (the chosen sketch): name with a login pill, masked email and endpoint, the 7 resource badges coloured by state, and Manage sharing / Remove buttons. Manage, Add and Remove open a right-hand panel that previews every change per resource before Apply and then shows the result line by line.

FORM: canon (the category standard), chosen by the user on the decision page; quality bar Vercel and Linear. seed:876bb95b3aaab58d

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
