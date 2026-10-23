// Prints a Block Kit Builder link for the Home tab using a sample of real jobs from Oct 23, 2026.
const { homeView } = require('../src/views');
const { zonedDate } = require('../src/jobs');

const d = '2026-10-23';
const job = (jobNumber, client, location, issue, time, extra = {}) => ({
  jobNumber, client, location, issue, when: zonedDate(d, time), timed: true, status: 'scheduled', ...extra,
});
const jobs = [
  job('132179', 'Fairgrove Property Management', '4985 Elsa Rd, San Diego, CA 92120', 'Toilet Is Running Continuously', '09:00', { workOrder: '260995-1', threadTs: '1792711637.429499', filesUrl: 'https://drive.google.com/drive/folders/1As0FYVrBcTXJABht8RBOBJ1qag_NB2tj' }),
  job('131898', 'Torrey Pines Property Mgmt', '3629 South Barcelona Street, Spring Valley, CA 91977', 'Inspect water meter and check for leaks, water bill went up', '10:00', { workOrder: '383273-1' }),
  job('132101', 'Torrey Pines Property Mgmt', '543 "F" Avenue, Unit 2, Coronado, CA 92118', 'Bathroom shower clogged', '10:00', { workOrder: '384999-1' }),
  job('132178', 'David Bejarano', '446 Via Maggiore, Chula Vista, CA 91914', 'Install leak detection / auto shut-off; bathroom sink leaking', '10:00', { threadTs: '1792709456.632059', filesUrl: 'https://drive.google.com/drive/folders/1VXuXtT6O0oB2QdasjenmphgvXK2BcBnp' }),
  job('131842', 'Fairgrove Property Management', '4037 Winona Avenue #5, San Diego, CA 92105', 'Kitchen sink hose leaking; no hot water at shower', '11:00', { workOrder: '254958-1' }),
  job('132177', 'Beyond Property Management', '4346 38th St., San Diego, CA 92105', 'Water Heater (no hot water, tenant marked urgent)', '14:00', { workOrder: '33580-1', threadTs: '1792706570.836179', filesUrl: 'https://drive.google.com/drive/folders/1JBdH0NGkbaFmHpUwX8HYQw2KvCT4qTM6' }),
  job('132180', 'Beyond Property Management', '7987 Lincoln St., Lemon Grove, CA 91945', 'Install dishwasher air gap and shut-off', '14:00', { workOrder: '33583-1', threadTs: '1792712542.021789', filesUrl: 'https://drive.google.com/drive/folders/1fzxdv2yz9OELQN-aUyRij7KwuGnJUjYl' }),
  { jobNumber: '132181', client: 'Fairgrove Property Management', location: '9928 Buena Vista Dr, Spring Valley, CA 91977', issue: 'Drain/Pipe Clog (sewage backing up)', status: 'new', when: zonedDate('2026-10-22', '17:22'), timed: false },
];
const store = { jobs, techs: () => ['Edgar', 'Eduardo', 'Esteban'], updatedAt: new Date() };
const view = homeView(store, { tab: 'today', tech: 'all' });
const payload = { blocks: view.blocks };
console.log(JSON.stringify(view.blocks).length, 'chars,', view.blocks.length, 'blocks');
console.log('https://app.slack.com/block-kit-builder#' + encodeURIComponent(JSON.stringify(payload)));
