import test from 'node:test';
import {exerciseMaintenance} from '../helpers/control-maintenance-controller-fixture.js';
test('P6-MAINT-I06 actual duplicate-case witnesses permit automatic reviewed replacement with smaller final selection',{timeout:290000},t=>exerciseMaintenance(t,'dedup'));
