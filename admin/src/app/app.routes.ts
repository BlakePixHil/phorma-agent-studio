import { Route, Routes } from '@angular/router';

import { BILLING_VIEW_ID } from './core/billing-models';
import { IMPERSONATION_VIEW_ID } from './core/impersonation-models';
import { TELEMETRY_ROUTES, type TelemetryRoute } from './core/models';
import { ORG_VIEW_ID } from './core/org-models';

/** The lazy component loader shape the router accepts. */
type ViewLoader = NonNullable<Route['loadComponent']>;

/**
 * One route per aggregate view, named after the Admin_API route it reads.
 *
 * The paths are DERIVED from `TELEMETRY_ROUTES` rather than restated, so the
 * router, the header nav and the API client cannot drift apart: adding a sixth
 * aggregate route to the twin adds its route and its nav entry with no edit
 * here.
 *
 * Each view is lazily loaded, so a visitor pays for the view they open and the
 * geography map's generated path data never loads for anyone reading another view.
 *
 * The outlet these render into lives inside the shell's signed-in branch (see
 * `app.html`), so no view component is constructed - and no `resource()` fires -
 * while there is no Clerk session (Requirement 10.3).
 */
const VIEW_LOADERS: Record<TelemetryRoute, ViewLoader> = {
  summary: () => import('./views/overview/overview').then((m) => m.Overview),
  geography: () => import('./views/geography/geography').then((m) => m.Geography),
  environment: () => import('./views/environment/environment').then((m) => m.Environment),
  features: () => import('./views/features/features').then((m) => m.Features),
  trend: () => import('./views/trend/trend').then((m) => m.Trend),
};

export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: TELEMETRY_ROUTES[0] },
  ...TELEMETRY_ROUTES.map((view) => ({
    path: view,
    data: { view },
    loadComponent: VIEW_LOADERS[view],
  })),
  // The spend view is listed EXPLICITLY rather than derived, because it is not a
  // telemetry aggregate: it reads `/api/admin/billing/*` and fetches two routes,
  // so there is no one-to-one route to derive it from. Keeping the telemetry map
  // exhaustive over `TelemetryRoute` preserves the property that matters - a sixth
  // aggregate route still cannot compile without a loader and a nav entry.
  {
    path: BILLING_VIEW_ID,
    data: { view: BILLING_VIEW_ID },
    loadComponent: () => import('./views/spend/spend').then((m) => m.Spend),
  },
  // Organisations is listed explicitly for the same reason Spend is: it reads
  // `/api/admin/organisations/*` across four routes and two of its own resources,
  // so there is no one-to-one aggregate route to derive a path from. Lazy like
  // every other view, so the only visitor who pays for its form controls is one
  // who opens it.
  {
    path: ORG_VIEW_ID,
    data: { view: ORG_VIEW_ID },
    loadComponent: () => import('./views/organisations/organisations').then((m) => m.Organisations),
  },
  // Impersonation, listed explicitly for the same reason as the two above: it reads
  // `/api/admin/impersonation` and, as the act-as caller, `/api/deployments`, so
  // there is no one aggregate route to derive a path from. Lazy like every other
  // view - and the only visitor who loads it is one who opened it, which is worth
  // having for a surface that is used rarely and on purpose.
  {
    path: IMPERSONATION_VIEW_ID,
    data: { view: IMPERSONATION_VIEW_ID },
    loadComponent: () => import('./views/impersonation/impersonation').then((m) => m.Impersonation),
  },
  { path: '**', redirectTo: TELEMETRY_ROUTES[0] },
];
