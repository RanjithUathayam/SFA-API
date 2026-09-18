import { Routes } from '@angular/router';

export const routes: Routes = [
  {
    path: '',
    loadComponent: () => import('./components/dashboard/dashboard.component').then(m => m.DashboardComponent),
  },
  {
    path: 'products',
    loadComponent: () => import('./components/products/products.component').then(m => m.ProductsComponent),
  },
  {
    path: 'master/pricelists',
    redirectTo: 'pricelist',
  },
  {
    path: 'master/:type',
    loadComponent: () => import('./components/master/master.component').then(m => m.MasterComponent),
  },
  {
    path: 'pricelist',
    loadComponent: () => import('./components/pricelist/price-list.component').then(m => m.PriceListComponent),
  },
  {
    path: 'ehr',
    loadComponent: () => import('./components/ehr/ehr.component').then(m => m.EhrComponent),
  },
  {
    path: 'sync',
    loadComponent: () => import('./components/sync/sync.component').then(m => m.SyncComponent),
  },
  { path: '**', redirectTo: '' },
];
