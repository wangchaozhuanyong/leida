import test from 'node:test';
import assert from 'node:assert/strict';
import {fetchTiboTimeline,TIBO_SOURCE} from '../src/server/tibo-timeline';
test('旧收费适配器的真实读取已停用，任何凭据状态均不得发起网络请求',async()=>{let calls=0;await assert.rejects(fetchTiboTimeline(TIBO_SOURCE,{fetcher:async()=>{calls++;throw new Error('must not request');}}),/收费采集已停用/);assert.equal(calls,0);});
