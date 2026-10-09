let dashboardState = {
    customers: [],
    plans: [],
    subscriptions: []
};

const DENSITY_KEY = 'sub_billing_density';

// Tab switching
function showTab(tabName) {
    // Hide all tab contents
    const contents = document.querySelectorAll('.tab-content');
    contents.forEach(content => {
        content.classList.remove('active');
    });

    // Remove active class from all buttons
    const buttons = document.querySelectorAll('.tab-btn');
    buttons.forEach(button => {
        button.classList.remove('active');
    });

    // Show the selected tab
    const tabElement = document.getElementById(tabName);
    if (tabElement) {
        tabElement.classList.add('active');
    }
    
    // Highlight the button for this tab
    const activeButton = document.querySelector(`[data-tab="${tabName}"]`);
    if (activeButton) {
        activeButton.classList.add('active');
    }

    tabButtonsAria(tabName);
}

function tabButtonsAria(activeTab) {
    const tabButtons = document.querySelectorAll('.tab-btn');
    tabButtons.forEach(button => {
        const isActive = button.getAttribute('data-tab') === activeTab;
        button.setAttribute('aria-selected', isActive ? 'true' : 'false');
    });
}

function setEmptyState(tbody, colspan, message) {
    tbody.innerHTML = `<tr><td class="empty-row" colspan="${colspan}">${message}</td></tr>`;
}

function clearFieldErrors(fieldIds = []) {
    fieldIds.forEach((fieldId) => {
        const field = document.getElementById(fieldId);
        if (field) {
            field.classList.remove('input-error');
        }
    });
}

function showFormErrors(containerId, messages = []) {
    const container = document.getElementById(containerId);
    if (!container) {
        return;
    }

    if (!messages.length) {
        container.classList.remove('active');
        container.innerHTML = '';
        return;
    }

    container.classList.add('active');
    container.innerHTML = messages.map((message) => `<div>${message}</div>`).join('');
}

function validateCustomerForm() {
    const errors = [];
    const invalidFieldIds = [];
    const customerType = (document.getElementById('customerType').value || '').trim();
    const adminEmail = (document.getElementById('adminEmail').value || '').trim();
    const firstName = (document.getElementById('firstName').value || '').trim();
    const lastName = (document.getElementById('lastName').value || '').trim();
    const companyName = (document.getElementById('companyName').value || '').trim();
    const companyTaxId = (document.getElementById('companyTaxId').value || '').trim();
    const addressSt = (document.getElementById('addressSt').value || '').trim();
    const city = (document.getElementById('city').value || '').trim();
    const state = (document.getElementById('state').value || '').trim();
    const country = (document.getElementById('country').value || '').trim();
    const creditLimit = (document.getElementById('creditLimit').value || '').trim();

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

    if (!customerType) {
        errors.push('Customer type is required.');
        invalidFieldIds.push('customerType');
    }

    if (!adminEmail || !emailRegex.test(adminEmail)) {
        errors.push('Enter a valid admin email address.');
        invalidFieldIds.push('adminEmail');
    }

    if (customerType === 'individual') {
        if (!firstName) {
            errors.push('First name is required for individual customers.');
            invalidFieldIds.push('firstName');
        }

        if (!lastName) {
            errors.push('Last name is required for individual customers.');
            invalidFieldIds.push('lastName');
        }
    }

    if (customerType === 'company') {
        if (!companyName) {
            errors.push('Company name is required for company customers.');
            invalidFieldIds.push('companyName');
        }

        if (!companyTaxId) {
            errors.push('Company tax ID is required for company customers.');
            invalidFieldIds.push('companyTaxId');
        }
    }

    if (!addressSt || addressSt.length < 10) {
        errors.push('Address must be at least 10 characters.');
        invalidFieldIds.push('addressSt');
    }

    if (!city) {
        errors.push('City is required.');
        invalidFieldIds.push('city');
    }

    if (!state) {
        errors.push('State is required.');
        invalidFieldIds.push('state');
    }

    if (!country) {
        errors.push('Country is required.');
        invalidFieldIds.push('country');
    }

    if (creditLimit !== '') {
        const parsedCreditLimit = Number(creditLimit);
        if (Number.isNaN(parsedCreditLimit) || parsedCreditLimit < 0) {
            errors.push('Credit limit must be a non-negative number.');
            invalidFieldIds.push('creditLimit');
        }
    }

    return { errors, invalidFieldIds };
}

function validatePlanForm() {
    const errors = [];
    const invalidFieldIds = [];

    const planId = (document.getElementById('planId').value || '').trim();
    const planName = (document.getElementById('planName').value || '').trim();
    const amount = Number(document.getElementById('planAmount').value);
    const validityMonths = Number(document.getElementById('validityMonths').value);
    const nonNegativeFieldIds = ['numbers', 'extensions', 'monitoringExtensions'];

    if (!planId) {
        errors.push('Plan ID is required.');
        invalidFieldIds.push('planId');
    }

    if (!planName) {
        errors.push('Plan name is required.');
        invalidFieldIds.push('planName');
    }

    if (Number.isNaN(amount) || amount <= 0) {
        errors.push('Plan amount must be greater than 0.');
        invalidFieldIds.push('planAmount');
    }

    if (Number.isNaN(validityMonths) || validityMonths <= 0) {
        errors.push('Validity months must be greater than 0.');
        invalidFieldIds.push('validityMonths');
    }

    nonNegativeFieldIds.forEach((fieldId) => {
        const value = Number(document.getElementById(fieldId).value);
        if (!Number.isInteger(value) || value < 0) {
            invalidFieldIds.push(fieldId);
        }
    });

    if (invalidFieldIds.some((fieldId) => nonNegativeFieldIds.includes(fieldId))) {
        errors.push('Entitlement values must be non-negative numbers.');
    }

    return { errors, invalidFieldIds };
}

function validateSubscriptionForm() {
    const errors = [];
    const invalidFieldIds = [];
    const customerId = (document.getElementById('subCustomerId').value || '').trim();
    const planId = (document.getElementById('subPlanId').value || '').trim();

    if (!customerId) {
        errors.push('Please select a customer.');
        invalidFieldIds.push('subCustomerId');
    }

    if (!planId) {
        errors.push('Please select a plan.');
        invalidFieldIds.push('subPlanId');
    }

    return { errors, invalidFieldIds };
}

function setTableLoading(tbodyId, columnCount) {
    const tbody = document.getElementById(tbodyId);
    if (!tbody) return;

    const skeletonRows = Array.from({ length: 3 }).map(() => {
        const cells = Array.from({ length: columnCount }).map(() => '<td><span class="skeleton-line"></span></td>').join('');
        return `<tr>${cells}</tr>`;
    }).join('');

    tbody.innerHTML = skeletonRows;

    const tableWrap = tbody.closest('.table-wrap');
    if (tableWrap) {
        tableWrap.classList.add('loading');
    }
}

function clearTableLoading(tbodyId) {
    const tbody = document.getElementById(tbodyId);
    if (!tbody) return;

    const tableWrap = tbody.closest('.table-wrap');
    if (tableWrap) {
        tableWrap.classList.remove('loading');
    }
}

function applyDensityMode(mode) {
    const compact = mode === 'compact';
    document.body.classList.toggle('compact', compact);

    const toggleBtn = document.getElementById('densityToggle');
    if (toggleBtn) {
        toggleBtn.textContent = compact ? 'Comfortable View' : 'Compact View';
    }
}

function toggleDensityMode() {
    const nextMode = document.body.classList.contains('compact') ? 'comfortable' : 'compact';
    localStorage.setItem(DENSITY_KEY, nextMode);
    applyDensityMode(nextMode);
}

function initializeDensityMode() {
    const savedMode = localStorage.getItem(DENSITY_KEY) || 'comfortable';
    applyDensityMode(savedMode);
}

async function refreshAllData() {
    await Promise.allSettled([
        loadCustomers(),
        loadPlans(),
        loadSubscriptions()
    ]);
    showAlert('Dashboard refreshed', 'success');
}

function updateKpis() {
    const customerCount = dashboardState.customers.length;
    const planCount = dashboardState.plans.length;
    const activeSubscriptions = dashboardState.subscriptions.filter(sub => (sub.status || '').toLowerCase() === 'active').length;

    const customerKpi = document.getElementById('kpiCustomers');
    const planKpi = document.getElementById('kpiPlans');
    const activeSubKpi = document.getElementById('kpiActiveSubscriptions');

    if (customerKpi) customerKpi.textContent = String(customerCount);
    if (planKpi) planKpi.textContent = String(planCount);
    if (activeSubKpi) activeSubKpi.textContent = String(activeSubscriptions);
}

// Show alert message
function showAlert(message, type) {
    const alertDiv = document.createElement('div');
    alertDiv.className = `alert ${type}`;
    alertDiv.textContent = message;

    const host = document.getElementById('alertsHost') || document.querySelector('.container');
    host.prepend(alertDiv);

    setTimeout(() => {
        alertDiv.remove();
    }, 4000);
}

// Load customers for dropdown and table
async function loadCustomers() {
    setTableLoading('customersBody', 6);

    try {
        const response = await fetch('/api/customers');
        const result = await response.json();
        const customers = result.data || result;
        dashboardState.customers = Array.isArray(customers) ? customers : [];

        // Populate dropdown
        const customerSelect = document.getElementById('subCustomerId');
        if (customerSelect) {
            customerSelect.innerHTML = '<option value="">Select Customer...</option>';

            customers.forEach(customer => {
                const option = document.createElement('option');
                option.value = customer.customer_id;
                option.textContent = customer.admin_email || customer.company_name || customer.customer_id;
                customerSelect.appendChild(option);
            });
        }

        // Populate table
        const tbody = document.getElementById('customersBody');
        tbody.innerHTML = '';

        if (dashboardState.customers.length === 0) {
            setEmptyState(tbody, 6, 'No customers found. Create the first customer to begin.');
            clearTableLoading('customersBody');
            updateKpis();
            return;
        }

        dashboardState.customers.forEach(customer => {
            const customerName = `${customer.first_name || ''} ${customer.last_name || ''}`.trim() || customer.company_name || 'N/A';
            const row = document.createElement('tr');
            row.innerHTML = `
                <td>${customer.customer_id}</td>
                <td>${customerName}</td>
                <td>${customer.admin_email || 'N/A'}</td>
                <td>${customer.customer_type}</td>
                <td>${customer.currency}</td>
                <td>
                    <button class="action-btn delete-btn" onclick="deleteCustomer('${customer.customer_id}')">Delete</button>
                </td>
            `;
            tbody.appendChild(row);
        });

        clearTableLoading('customersBody');
        updateKpis();
    } catch (error) {
        clearTableLoading('customersBody');
        console.error('Error loading customers:', error);
        showAlert('Error loading customers: ' + error.message, 'error');
    }
}

// Create customer
async function createCustomer(event) {
    event.preventDefault();

    clearFieldErrors(['customerType', 'adminEmail', 'firstName', 'lastName', 'companyName', 'companyTaxId', 'addressSt', 'city', 'state', 'country', 'creditLimit']);
    showFormErrors('customerFormErrors', []);

    const customerValidation = validateCustomerForm();
    if (customerValidation.errors.length > 0) {
        customerValidation.invalidFieldIds.forEach((fieldId) => {
            const field = document.getElementById(fieldId);
            if (field) {
                field.classList.add('input-error');
            }
        });
        showFormErrors('customerFormErrors', customerValidation.errors);
        return;
    }

    const formData = {
        customer_type: document.getElementById('customerType').value,
        admin_email: document.getElementById('adminEmail').value,
        phone: document.getElementById('phone').value,
        company_name: document.getElementById('companyName').value,
        company_tax_id: document.getElementById('companyTaxId').value,
        first_name: document.getElementById('firstName').value,
        last_name: document.getElementById('lastName').value,
        address_st: document.getElementById('addressSt').value,
        city: document.getElementById('city').value,
        state: document.getElementById('state').value,
        country: document.getElementById('country').value,
        fr_cusid: document.getElementById('frCusid').value || null,
        credit_limit: document.getElementById('creditLimit').value === ''
            ? 0
            : parseFloat(document.getElementById('creditLimit').value)
    };

    try {
        const response = await fetch('/api/customers', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(formData)
        });

        const result = await response.json();

        if (!response.ok) {
            // Handle validation errors
            if (result.errors && Array.isArray(result.errors)) {
                result.errors.forEach(error => {
                    showAlert(error, 'error');
                });
            } else {
                showAlert('Error: ' + (result.message || 'Failed to create customer'), 'error');
            }
            return;
        }

        showAlert('Customer created successfully! ID: ' + result.data.customer_id, 'success');
        document.getElementById('customerForm').reset();
        showFormErrors('customerFormErrors', []);
        loadCustomers();
    } catch (error) {
        console.error('Error:', error);
        showAlert('Error creating customer: ' + error.message, 'error');
    }
}

// Delete customer
async function deleteCustomer(customerId) {
    if (!confirm('Are you sure you want to delete this customer?')) return;

    try {
        const response = await fetch(`/api/customers/${customerId}`, {
            method: 'DELETE'
        });

        const result = await response.json();

        if (!response.ok) {
            showAlert('Error: ' + (result.message || 'Failed to delete customer'), 'error');
            return;
        }

        showAlert('Customer deleted successfully!', 'success');
        loadCustomers();
    } catch (error) {
        console.error('Error:', error);
        showAlert('Error deleting customer: ' + error.message, 'error');
    }
}

// Load plans for dropdown and table
async function loadPlans() {
    setTableLoading('plansBody', 9);

    try {
        const response = await fetch('/api/plans');
        const result = await response.json();
        const plans = result.data || result;
        dashboardState.plans = Array.isArray(plans) ? plans : [];

        // Populate dropdown
        const planSelect = document.getElementById('subPlanId');
        if (planSelect) {
            planSelect.innerHTML = '<option value="">Select Plan...</option>';

            dashboardState.plans.forEach(plan => {
                const option = document.createElement('option');
                option.value = plan.plan_id;
                option.textContent = `${plan.name} - ${plan.amount} ${plan.currency}`;
                planSelect.appendChild(option);
            });
        }

        // Populate table
        const tbody = document.getElementById('plansBody');
        tbody.innerHTML = '';

        if (dashboardState.plans.length === 0) {
            setEmptyState(tbody, 9, 'No plans found. Create a plan to sell subscriptions.');
            clearTableLoading('plansBody');
            updateKpis();
            return;
        }

        dashboardState.plans.forEach(plan => {
            const row = document.createElement('tr');
            row.innerHTML = `
                <td>${plan.plan_id}</td>
                <td>${plan.name}</td>
                <td>${plan.amount} ${plan.currency}</td>
                <td>${plan.validity_months} months</td>
                <td>${plan.numbers || 0}</td>
                <td>${plan.extensions || 0}</td>
                <td>${plan.monitoring_extensions || 0}</td>
                <td>${new Date(plan.created_at).toLocaleDateString()}</td>
                <td>
                    <button class="action-btn delete-btn" onclick="deletePlan('${plan.plan_id}')">Delete</button>
                </td>
            `;
            tbody.appendChild(row);
        });

        clearTableLoading('plansBody');
        updateKpis();
    } catch (error) {
        clearTableLoading('plansBody');
        console.error('Error loading plans:', error);
        showAlert('Error loading plans: ' + error.message, 'error');
    }
}

// Create plan
async function createPlan(event) {
    event.preventDefault();

    clearFieldErrors(['planId', 'planName', 'planAmount', 'validityMonths', 'numbers', 'extensions', 'monitoringExtensions']);
    showFormErrors('planFormErrors', []);

    const planValidation = validatePlanForm();
    if (planValidation.errors.length > 0) {
        planValidation.invalidFieldIds.forEach((fieldId) => {
            const field = document.getElementById(fieldId);
            if (field) {
                field.classList.add('input-error');
            }
        });
        showFormErrors('planFormErrors', planValidation.errors);
        return;
    }

    const formData = {
        plan_id: document.getElementById('planId').value,
        name: document.getElementById('planName').value,
        amount: parseFloat(document.getElementById('planAmount').value),
        currency: document.getElementById('planCurrency').value,
        validity_months: parseInt(document.getElementById('validityMonths').value),
        numbers: parseInt(document.getElementById('numbers').value) || 0,
        extensions: parseInt(document.getElementById('extensions').value) || 0,
        monitoring_extensions: parseInt(document.getElementById('monitoringExtensions').value) || 0
    };

    try {
        const response = await fetch('/api/plans', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(formData)
        });

        const result = await response.json();

        if (!response.ok) {
            showAlert('Error: ' + (result.message || 'Failed to create plan'), 'error');
            return;
        }

        showAlert('Plan created successfully!', 'success');
        document.getElementById('planForm').reset();
        showFormErrors('planFormErrors', []);
        loadPlans();
    } catch (error) {
        console.error('Error:', error);
        showAlert('Error creating plan: ' + error.message, 'error');
    }
}

// Delete plan
async function deletePlan(planId) {
    if (!confirm('Are you sure you want to delete this plan?')) return;

    try {
        const response = await fetch(`/api/plans/${planId}`, {
            method: 'DELETE'
        });

        const result = await response.json();

        if (!response.ok) {
            showAlert('Error: ' + (result.message || 'Failed to delete plan'), 'error');
            return;
        }

        showAlert('Plan deleted successfully!', 'success');
        loadPlans();
    } catch (error) {
        console.error('Error:', error);
        showAlert('Error deleting plan: ' + error.message, 'error');
    }
}

// Load subscriptions for table
async function loadSubscriptions() {
    setTableLoading('subscriptionsBody', 7);

    try {
        const response = await fetch('/api/subscriptions');
        const result = await response.json();
        const subscriptions = result.data || result;
        dashboardState.subscriptions = Array.isArray(subscriptions) ? subscriptions : [];

        const tbody = document.getElementById('subscriptionsBody');
        tbody.innerHTML = '';

        if (dashboardState.subscriptions.length === 0) {
            setEmptyState(tbody, 7, 'No subscriptions found. Create a subscription from the form.');
            clearTableLoading('subscriptionsBody');
            updateKpis();
            return;
        }

        dashboardState.subscriptions.forEach(subscription => {
            const row = document.createElement('tr');
            const statusClass = subscription.status.toLowerCase();
            row.innerHTML = `
                <td>${subscription.subscription_id || subscription.id}</td>
                <td>${subscription.customer_id}</td>
                <td>${subscription.plan_id}</td>
                <td><span class="status ${statusClass}">${subscription.status}</span></td>
                <td>${new Date(subscription.start_date).toLocaleDateString()}</td>
                <td>${subscription.next_billing ? new Date(subscription.next_billing).toLocaleDateString() : 'N/A'}</td>
                <td>
                    ${subscription.status !== 'cancelled' ? `<button class="action-btn delete-btn" onclick="cancelSubscription('${subscription.subscription_id || subscription.id}')">Cancel</button>` : 'Cancelled'}
                </td>
            `;
            tbody.appendChild(row);
        });

        clearTableLoading('subscriptionsBody');
        updateKpis();
    } catch (error) {
        clearTableLoading('subscriptionsBody');
        console.error('Error loading subscriptions:', error);
        showAlert('Error loading subscriptions: ' + error.message, 'error');
    }
}

// Create subscription
async function createSubscription(event) {
    event.preventDefault();

    clearFieldErrors(['subCustomerId', 'subPlanId']);
    showFormErrors('subscriptionFormErrors', []);

    const subscriptionValidation = validateSubscriptionForm();
    if (subscriptionValidation.errors.length > 0) {
        subscriptionValidation.invalidFieldIds.forEach((fieldId) => {
            const field = document.getElementById(fieldId);
            if (field) {
                field.classList.add('input-error');
            }
        });
        showFormErrors('subscriptionFormErrors', subscriptionValidation.errors);
        return;
    }

    const customerId = document.getElementById('subCustomerId').value;
    const planId = document.getElementById('subPlanId').value;
    const status = document.getElementById('subStatus').value;

    const formData = {
        customer_id: customerId,
        plan_id: planId,
        status: status
    };

    try {
        const response = await fetch('/api/subscriptions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(formData)
        });

        const result = await response.json();

        if (!response.ok) {
            showAlert('Error: ' + (result.message || 'Failed to create subscription'), 'error');
            return;
        }

        showAlert('Subscription created successfully!', 'success');
        document.getElementById('subscriptionForm').reset();
        showFormErrors('subscriptionFormErrors', []);
        loadSubscriptions();
    } catch (error) {
        console.error('Error:', error);
        showAlert('Error creating subscription: ' + error.message, 'error');
    }
}

// Cancel subscription
async function cancelSubscription(subscriptionId) {
    if (!confirm('Are you sure you want to cancel this subscription?')) return;

    try {
        const response = await fetch(`/api/subscriptions/${subscriptionId}`, {
            method: 'DELETE'
        });

        const result = await response.json();

        if (!response.ok) {
            showAlert('Error: ' + (result.message || 'Failed to cancel subscription'), 'error');
            return;
        }

        showAlert('Subscription cancelled successfully!', 'success');
        loadSubscriptions();
    } catch (error) {
        console.error('Error:', error);
        showAlert('Error cancelling subscription: ' + error.message, 'error');
    }
}

// Initialize on page load
document.addEventListener('DOMContentLoaded', () => {
    initializeDensityMode();

    // Attach tab button click listeners
    const tabButtons = document.querySelectorAll('.tab-btn');
    tabButtons.forEach(button => {
        button.addEventListener('click', function() {
            const tabName = this.getAttribute('data-tab');
            showTab(tabName);
        });
    });
    
    // Set active tab
    document.querySelector('.tab-btn').classList.add('active');
    document.getElementById('customers').classList.add('active');
    tabButtonsAria('customers');

    // Attach form listeners
    document.getElementById('customerForm').addEventListener('submit', createCustomer);
    document.getElementById('planForm').addEventListener('submit', createPlan);
    document.getElementById('subscriptionForm').addEventListener('submit', createSubscription);

    const densityToggle = document.getElementById('densityToggle');
    if (densityToggle) {
        densityToggle.addEventListener('click', toggleDensityMode);
    }

    const refreshAll = document.getElementById('refreshAll');
    if (refreshAll) {
        refreshAll.addEventListener('click', refreshAllData);
    }

    // Load initial data
    loadCustomers();
    loadPlans();
    loadSubscriptions();
});
