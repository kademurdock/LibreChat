import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { IAgentCategory } from '..';
import { createAgentCategoryMethods } from './agentCategory';
import { createModels } from '../models';

jest.mock('~/config/winston', () => ({
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
}));

let mongoServer: MongoMemoryServer;
let AgentCategory: mongoose.Model<IAgentCategory>;
let methods: ReturnType<typeof createAgentCategoryMethods>;

const STOCK = ['general', 'hr', 'rd', 'finance', 'it', 'sales', 'aftersales'];
const KADE = ['friends', 'helpers', 'creative', 'games', 'family'];

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  createModels(mongoose);
  AgentCategory = mongoose.models.AgentCategory as mongoose.Model<IAgentCategory>;
  methods = createAgentCategoryMethods(mongoose);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  await AgentCategory.deleteMany({});
  delete process.env.KADE_STOCK_CATEGORIES;
});

afterEach(() => {
  delete process.env.KADE_STOCK_CATEGORIES;
});

const activeValues = async () => (await methods.getActiveCategories()).map((c) => c.value).sort();

describe('Kade categories replace the stock office ones (Oct 29 2026)', () => {
  it('a fresh database gets only the five real categories', async () => {
    await methods.ensureDefaultCategories();
    expect(await activeValues()).toEqual([...KADE].sort());
  });

  it('switches off the stock rows already there, keeps them, and leaves custom ones alone', async () => {
    for (const value of STOCK.filter((v) => v !== 'sales')) {
      await AgentCategory.create({ value, label: `com_agents_category_${value}`, isActive: true });
    }
    await AgentCategory.create({ value: 'sales', label: 'Sales', isActive: true, custom: true });
    expect(await methods.ensureDefaultCategories()).toBe(true);
    expect(await activeValues()).toEqual([...KADE, 'sales'].sort());
    expect(await AgentCategory.countDocuments({ value: { $in: STOCK } })).toBe(STOCK.length);
    expect(await methods.ensureDefaultCategories()).toBe(false);
  });

  it('KADE_STOCK_CATEGORIES=1 brings the stock categories back', async () => {
    await methods.ensureDefaultCategories();
    for (const value of STOCK) {
      await AgentCategory.create({ value, label: `com_agents_category_${value}`, isActive: false });
    }
    process.env.KADE_STOCK_CATEGORIES = '1';
    await methods.ensureDefaultCategories();
    const active = await activeValues();
    for (const value of STOCK) {
      expect(active).toContain(value);
    }
  });
});
