import type { AppState } from './types';
import * as ops from './ops';
import { DAY } from './util';

/** Populate a draft with an example plan + goal so new users can explore. */
export function seedDemo(d: AppState) {
  const g = ops.createGoal(d, '找到适合自己的运动习惯', {
    why: '久坐让下午效率很低，想要更稳定的精力',
    doneWhen: '连续 4 周、每周至少 3 次，而且不觉得是负担',
    cadenceDays: 7,
    nextAction: '今晚下班后快走 20 分钟',
  });
  ops.addTask(d, '试一次晨跑 15 分钟');
  ops.addTask(d, '试一节线上瑜伽课');
  ops.setTaskStatus(d, g.moves[0].id, 'done');
  g.createdAt -= 8 * DAY;
  g.checkpoints.push({
    id: 'demo-cp1',
    at: Date.now() - DAY,
    progress: 20,
    verdict: 'drifting',
    did: '- 晨跑 2 次\n- 一次瑜伽没坚持下来',
    learned: '早上时间太紧，晚上反而更容易开始',
    next: '今晚下班后快走 20 分钟',
  });

  const p = ops.createPlan(d, '个人网站改版', '两周内上线新版首页与博客，加载时间 < 1s');
  p.phases = [];
  ops.addPhase(d, '调研', '确定参考站点与内容结构');
  ops.addPhase(d, '设计', '完成首页与文章页的视觉稿');
  ops.addPhase(d, '实现', '首页、博客列表、文章页上线到预览环境');
  const [ph1, ph2] = p.phases;
  ops.addTask(d, '收集 5 个喜欢的个人网站', ph1.id);
  ops.addTask(d, '列出现有内容清单', ph1.id);
  ops.addTask(d, '首页线框图', ph2.id);
  ops.addTask(d, '确定字体与配色', ph2.id);
  ops.addTask(d, '文章页排版', ph2.id);
  ops.setTaskStatus(d, p.tasks[0].id, 'done');
  ops.setTaskStatus(d, p.tasks[1].id, 'done');
  ops.completePhase(d, ph1.id);
  ops.setTaskStatus(d, p.tasks[2].id, 'active');
  ops.revisePhase(d, ph2.id, '只做首页与文章页的视觉稿，博客列表复用文章页样式', '调研后发现列表页差异很小，单独设计不划算');
}
