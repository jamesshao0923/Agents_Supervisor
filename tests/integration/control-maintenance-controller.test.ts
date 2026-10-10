import test from 'node:test';
import {exerciseMaintenance} from '../helpers/control-maintenance-controller-fixture.js';
test('P6-MAINT-I05 real controllers automatically publish qualified regression revision and fully reverify after original repair pass',{timeout:290000},t=>exerciseMaintenance(t));
