import { AppController } from './AppController';
import './styles.css';

const root = document.querySelector<HTMLElement>('#app');
if (!root) throw new Error('找不到 #app 應用程式根節點');

const controller = new AppController(root);
void controller.initialize();

if (import.meta.hot) {
  import.meta.hot.dispose(() => controller.destroy());
}
