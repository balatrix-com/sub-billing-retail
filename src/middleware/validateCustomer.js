// Email validation helper
const isValidEmail = (email) => {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
};

// Customer creation validation middleware
const validateCustomerCreation = (req, res, next) => {
    const errors = [];
    
    const {
        customer_id,
        fr_cusid,
        customer_type,
        admin_email,
        first_name,
        last_name,
        company_name,
        company_tax_id,
        address_st,
        city,
        state,
        country,
        credit_limit
    } = req.body;

    // Skip all strict validation for T-series demo accounts
    if ((customer_id && customer_id.startsWith('T')) || (fr_cusid && fr_cusid.startsWith('T'))) {
        return next();
    }

    // Validate customer type
    if (!customer_type) {
        errors.push("Customer type is required");
    } else if (!['individual', 'company'].includes(customer_type)) {
        errors.push("Customer type must be 'individual' or 'company'");
    }

    // Validate email
    if (!admin_email) {
        errors.push("Admin email is required");
    } else if (!isValidEmail(admin_email)) {
        errors.push("Invalid email format");
    }

    // Validate based on customer type
    if (customer_type === 'individual') {
        if (!first_name) {
            errors.push("First name is required");
        }
        if (!last_name) {
            errors.push("Last name is required");
        }
    } else if (customer_type === 'company') {
        if (!company_name) {
            errors.push("Company name is required");
        }
        if (!company_tax_id) {
            errors.push("Company tax ID is required");
        }
    }

    // Validate address
    if (!address_st) {
        errors.push("Address is required");
    } else if (address_st.length < 10) {
        errors.push("Address must be at least 10 characters");
    }

    // Validate city
    if (!city) {
        errors.push("City is required");
    }

    // Validate state
    if (!state) {
        errors.push("State is required");
    }

    // Validate country
    if (!country) {
        errors.push("Country is required");
    } else {
        const allowedCountries = ['IND', 'USA', 'CAD', 'PAK', 'PHI', 'BNG', 'OTHER'];
        if (!allowedCountries.includes(country)) {
            errors.push(`Invalid country. Allowed values: ${allowedCountries.join(', ')}`);
        }
    }


    if (errors.length > 0) {
        return res.status(400).json({
            success: false,
            message: "Validation failed",
            errors: errors
        });
    }

    next();
};

module.exports = { validateCustomerCreation };
