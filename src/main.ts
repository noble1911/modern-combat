import './style.css';
import { App } from './game/app';

const app = new App(document.getElementById('app')!);
void app.boot();
(window as any).__app = app;
