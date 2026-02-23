<?php
/**
 * Peninsula Connector — PrestaShop Module
 * Sync PS → Peninsula DB (PSQL) : les produits sont ajoutés dans PS et poussés vers Peninsula.
 * Le client desktop Peninsula accède à la DB PSQL pour la boutique IRL.
 *
 * Flux : PrestaShop (web) → API Peninsula → PSQL ← Desktop Client (IRL)
 *
 * @author  Peninsula Armory Systems
 * @license GPL-3.0
 */

if (!defined('_PS_VERSION_')) {
    exit;
}

class PeninsulaConnector extends Module
{
    public function __construct()
    {
        $this->name          = 'peninsulaconnector';
        $this->tab           = 'administration';
        $this->version       = '0.2.0';
        $this->author        = 'Peninsula Armory Systems';
        $this->need_instance = 0;
        $this->bootstrap     = true;

        parent::__construct();

        $this->displayName = $this->l('Peninsula Connector');
        $this->description = $this->l('Synchronise les produits PS vers la DB Peninsula (PSQL) pour le client desktop boutique.');
        $this->ps_versions_compliancy = ['min' => '8.0.0', 'max' => '9.99.99'];
    }

    /* ── Install / Uninstall ─────────────────────────── */

    public function install()
    {
        return parent::install()
            // Legacy hooks (PS < 8 / API calls)
            && $this->registerHook('actionObjectProductAddAfter')
            && $this->registerHook('actionObjectProductUpdateAfter')
            && $this->registerHook('actionObjectProductDeleteAfter')
            // PS8 Symfony form hooks (new product page)
            && $this->registerHook('actionAfterCreateCreateProductFormHandler')
            && $this->registerHook('actionAfterUpdateProductFormHandler')
            && $this->registerHook('actionProductDelete')
            // Other hooks
            && $this->registerHook('actionValidateOrder')
            && $this->registerHook('actionUpdateQuantity')
            && $this->registerHook('displayBackOfficeHeader')
            && Configuration::updateValue('PENINSULA_API_URL', 'http://peninsula-api:4875')
            && Configuration::updateValue('PENINSULA_API_KEY', '')
            && Configuration::updateValue('PENINSULA_SYNC_INTERVAL', 300);
    }

    public function uninstall()
    {
        return parent::uninstall()
            && Configuration::deleteByName('PENINSULA_API_URL')
            && Configuration::deleteByName('PENINSULA_API_KEY')
            && Configuration::deleteByName('PENINSULA_SYNC_INTERVAL');
    }

    /* ── Configuration page (back-office) ────────────── */

    public function getContent()
    {
        $output = '';

        if (Tools::isSubmit('submitPeninsulaConfig')) {
            Configuration::updateValue('PENINSULA_API_URL', Tools::getValue('PENINSULA_API_URL'));
            Configuration::updateValue('PENINSULA_API_KEY', Tools::getValue('PENINSULA_API_KEY'));
            Configuration::updateValue('PENINSULA_SYNC_INTERVAL', (int) Tools::getValue('PENINSULA_SYNC_INTERVAL'));
            $output .= $this->displayConfirmation($this->l('Configuration sauvegardée.'));

            $status = $this->testApiConnection();
            if ($status === true) {
                $output .= $this->displayConfirmation($this->l('✓ Connexion à Peninsula API réussie.'));
            } else {
                $output .= $this->displayError($this->l('✗ Impossible de joindre Peninsula API : ') . $status);
            }
        }

        // Bouton Sync Full
        if (Tools::isSubmit('submitPeninsulaFullSync')) {
            $syncResult = $this->pushAllProductsToApi();
            $output .= $this->displayConfirmation(
                sprintf(
                    $this->l('Sync complète : %d envoyés, %d erreurs.'),
                    $syncResult['pushed'],
                    count($syncResult['errors'])
                )
            );
            foreach ($syncResult['errors'] as $err) {
                $output .= $this->displayError($err);
            }
        }

        return $output . $this->renderForm() . $this->renderSyncPanel();
    }

    protected function renderForm()
    {
        $fields_form = [
            'form' => [
                'legend' => [
                    'title' => $this->l('Paramètres Peninsula'),
                    'icon'  => 'icon-cogs',
                ],
                'input' => [
                    [
                        'type'     => 'text',
                        'label'    => $this->l('URL de l\'API Peninsula'),
                        'name'     => 'PENINSULA_API_URL',
                        'size'     => 64,
                        'required' => true,
                    ],
                    [
                        'type'     => 'text',
                        'label'    => $this->l('Clé API (JWT)'),
                        'name'     => 'PENINSULA_API_KEY',
                        'size'     => 64,
                        'required' => false,
                        'desc'     => $this->l('Token JWT pour s\'authentifier à l\'API Peninsula.'),
                    ],
                    [
                        'type'     => 'text',
                        'label'    => $this->l('Intervalle de synchro (secondes)'),
                        'name'     => 'PENINSULA_SYNC_INTERVAL',
                        'size'     => 10,
                        'required' => true,
                        'desc'     => $this->l('Pour la synchro auto CRON (défaut 300s = 5 min).'),
                    ],
                ],
                'submit' => [
                    'title' => $this->l('Sauvegarder'),
                ],
            ],
        ];

        $helper = new HelperForm();
        $helper->module          = $this;
        $helper->name_controller = $this->name;
        $helper->token           = Tools::getAdminTokenLite('AdminModules');
        $helper->currentIndex    = AdminController::$currentIndex . '&configure=' . $this->name;
        $helper->default_form_language    = (int) Configuration::get('PS_LANG_DEFAULT');
        $helper->allow_employee_form_lang = Configuration::get('PS_BO_ALLOW_EMPLOYEE_FORM_LANG') ?: 0;
        $helper->title     = $this->displayName;
        $helper->submit_action = 'submitPeninsulaConfig';

        $helper->fields_value['PENINSULA_API_URL']       = Configuration::get('PENINSULA_API_URL');
        $helper->fields_value['PENINSULA_API_KEY']        = Configuration::get('PENINSULA_API_KEY');
        $helper->fields_value['PENINSULA_SYNC_INTERVAL'] = Configuration::get('PENINSULA_SYNC_INTERVAL');

        return $helper->generateForm([$fields_form]);
    }

    protected function renderSyncPanel()
    {
        $actionUrl = AdminController::$currentIndex
            . '&configure=' . $this->name
            . '&token=' . Tools::getAdminTokenLite('AdminModules');

        $html = '<div class="panel">';
        $html .= '<div class="panel-heading"><i class="icon-refresh"></i> ' . $this->l('Synchronisation PS → Peninsula') . '</div>';
        $html .= '<p>' . $this->l('Pousse TOUS les produits du catalogue PrestaShop vers la base Peninsula (PSQL). Les produits créés/modifiés sont normalement synchronisés en temps réel via les hooks, mais ce bouton permet une synchro complète.') . '</p>';
        $html .= '<form method="post" action="' . $actionUrl . '">';
        $html .= '<button type="submit" name="submitPeninsulaFullSync" class="btn btn-primary">';
        $html .= '<i class="icon-upload"></i> ' . $this->l('Pousser tous les produits vers Peninsula');
        $html .= '</button>';
        $html .= '</form>';
        $html .= '</div>';

        return $html;
    }

    /* ── API helpers ─────────────────────────────────── */

    protected function testApiConnection()
    {
        $url = rtrim(Configuration::get('PENINSULA_API_URL'), '/') . '/health';
        try {
            $ch = curl_init($url);
            curl_setopt_array($ch, [
                CURLOPT_RETURNTRANSFER => true,
                CURLOPT_TIMEOUT        => 5,
                CURLOPT_HTTPHEADER     => ['Accept: application/json'],
            ]);
            $response = curl_exec($ch);
            $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
            $error    = curl_error($ch);
            curl_close($ch);

            if ($httpCode === 200) {
                $data = json_decode($response, true);
                if (isset($data['status']) && $data['status'] === 'ok') {
                    return true;
                }
            }
            return "HTTP $httpCode — $error";
        } catch (\Exception $e) {
            return $e->getMessage();
        }
    }

    protected function apiRequest($method, $endpoint, $body = null)
    {
        $baseUrl = rtrim(Configuration::get('PENINSULA_API_URL'), '/');
        $apiKey  = Configuration::get('PENINSULA_API_KEY');

        $ch = curl_init($baseUrl . $endpoint);
        $headers = [
            'Accept: application/json',
            'Content-Type: application/json',
        ];
        if (!empty($apiKey)) {
            $headers[] = 'Authorization: Bearer ' . $apiKey;
        }

        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT        => 15,
            CURLOPT_HTTPHEADER     => $headers,
            CURLOPT_CUSTOMREQUEST  => strtoupper($method),
        ]);

        if ($body !== null) {
            curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($body));
        }

        $response = curl_exec($ch);
        $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);

        return [
            'code' => $httpCode,
            'body' => json_decode($response, true),
        ];
    }

    /* ── Build product payload for the API ───────────── */

    protected function buildProductPayload(\Product $product, $action = 'update')
    {
        $idLang = (int) Configuration::get('PS_LANG_DEFAULT');

        // Récupérer le nom — string si chargé avec $idLang, array sinon
        if (is_array($product->name)) {
            $pName = $product->name[$idLang] ?? $product->name[1] ?? '';
        } else {
            $pName = (string) $product->name;
        }
        if (empty(trim($pName))) {
            $pName = 'Produit PS-' . $product->id;
        }

        // Récupérer la description
        if (is_array($product->description)) {
            $pDesc = $product->description[$idLang] ?? $product->description[1] ?? '';
        } else {
            $pDesc = (string) $product->description;
        }

        // Récupérer le link_rewrite
        if (is_array($product->link_rewrite)) {
            $linkRewrite = $product->link_rewrite[$idLang] ?? $product->link_rewrite[1] ?? '';
        } else {
            $linkRewrite = (string) $product->link_rewrite;
        }

        // Récupérer la catégorie
        $categoryName = null;
        if ($product->id_category_default) {
            $category = new \Category((int) $product->id_category_default, $idLang);
            if (\Validate::isLoadedObject($category)) {
                $categoryName = is_array($category->name)
                    ? ($category->name[$idLang] ?? $category->name[1] ?? null)
                    : (string) $category->name;
            }
        }

        // Récupérer le fabricant (marque)
        $brand = '';
        if ($product->id_manufacturer) {
            $manufacturer = new \Manufacturer((int) $product->id_manufacturer, $idLang);
            if (\Validate::isLoadedObject($manufacturer)) {
                $brand = $manufacturer->name ?: '';
            }
        }

        // Récupérer les images
        $images = [];
        $productImages = \Image::getImages($idLang, (int) $product->id);
        foreach ($productImages as $img) {
            $link = new \Link();
            $images[] = $link->getImageLink($linkRewrite, $img['id_image']);
        }

        // Quantité stock PS
        $quantity = (int) \StockAvailable::getQuantityAvailableByProduct((int) $product->id);

        return [
            'action'          => $action,
            'ps_product_id'   => (int) $product->id,
            'reference'       => $product->reference ?: 'PS-' . $product->id,
            'name'            => $pName,
            'description'     => strip_tags($pDesc),
            'brand'           => $brand,
            'price'           => (float) $product->price,
            'wholesale_price' => (float) $product->wholesale_price,
            'weight'          => (float) $product->weight,
            'quantity'         => $quantity,
            'condition'       => $product->condition ?: 'new',
            'tax_rate'        => (float) \Tax::getProductTaxRate((int) $product->id),
            'category_name'   => $categoryName,
            'images'          => $images,
            'active'          => (bool) $product->active,
        ];
    }

    /* ── Hooks : produit créé/modifié/supprimé ────────── */
    // Flux principal : PS → API Peninsula → PSQL

    public function hookActionObjectProductAddAfter($params)
    {
        $product = $params['object'];
        if (!$product || !$product->id) {
            return;
        }

        $payload = $this->buildProductPayload($product, 'create');
        $response = $this->apiRequest('POST', '/v1/webhook/prestashop/product', $payload);

        PrestaShopLogger::addLog(
            'Peninsula: produit #' . $product->id . ' (create) → API [HTTP ' . $response['code'] . ']',
            1, null, 'Product', (int) $product->id, true
        );
    }

    public function hookActionObjectProductUpdateAfter($params)
    {
        $product = $params['object'];
        if (!$product || !$product->id) {
            return;
        }

        $payload = $this->buildProductPayload($product, 'update');
        $response = $this->apiRequest('POST', '/v1/webhook/prestashop/product', $payload);

        PrestaShopLogger::addLog(
            'Peninsula: produit #' . $product->id . ' (update) → API [HTTP ' . $response['code'] . ']',
            1, null, 'Product', (int) $product->id, true
        );
    }

    public function hookActionObjectProductDeleteAfter($params)
    {
        $product = $params['object'];
        if (!$product || !$product->id) {
            return;
        }

        $payload = [
            'action'        => 'delete',
            'ps_product_id' => (int) $product->id,
            'reference'     => $product->reference ?: 'PS-' . $product->id,
            'name'          => 'deleted',
            'price'         => 0,
        ];

        $this->apiRequest('POST', '/v1/webhook/prestashop/product', $payload);

        PrestaShopLogger::addLog(
            'Peninsula: produit #' . $product->id . ' (delete) → API',
            1, null, 'Product', (int) $product->id, true
        );
    }

    /* ── PS8 Symfony hooks : produit créé/modifié via le nouveau back-office ─ */

    /**
     * Fired after a NEW product is created through the PS8 Symfony product form.
     */
    public function hookActionAfterCreateCreateProductFormHandler($params)
    {
        $productId = isset($params['id']) ? (int) $params['id'] : 0;
        if ($productId <= 0) {
            return;
        }

        $idLang = (int) Configuration::get('PS_LANG_DEFAULT');
        $product = new \Product($productId, false, $idLang);
        if (!\Validate::isLoadedObject($product)) {
            return;
        }

        $payload = $this->buildProductPayload($product, 'create');
        $response = $this->apiRequest('POST', '/v1/webhook/prestashop/product', $payload);

        PrestaShopLogger::addLog(
            'Peninsula PS8: produit #' . $productId . ' (create) → API [HTTP ' . $response['code'] . ']',
            1, null, 'Product', $productId, true
        );
    }

    /**
     * Fired after an EXISTING product is updated through the PS8 Symfony product form.
     */
    public function hookActionAfterUpdateProductFormHandler($params)
    {
        $productId = isset($params['id']) ? (int) $params['id'] : 0;
        if ($productId <= 0) {
            return;
        }

        $idLang = (int) Configuration::get('PS_LANG_DEFAULT');
        $product = new \Product($productId, false, $idLang);
        if (!\Validate::isLoadedObject($product)) {
            return;
        }

        $payload = $this->buildProductPayload($product, 'update');
        $response = $this->apiRequest('POST', '/v1/webhook/prestashop/product', $payload);

        PrestaShopLogger::addLog(
            'Peninsula PS8: produit #' . $productId . ' (update) → API [HTTP ' . $response['code'] . ']',
            1, null, 'Product', $productId, true
        );
    }

    /**
     * Fired when a product is deleted in PS8 (Symfony route).
     */
    public function hookActionProductDelete($params)
    {
        $productId = isset($params['id_product']) ? (int) $params['id_product'] : 0;
        if ($productId <= 0) {
            // Try alternate key
            $productId = isset($params['id']) ? (int) $params['id'] : 0;
        }
        if ($productId <= 0) {
            return;
        }

        $payload = [
            'action'        => 'delete',
            'ps_product_id' => $productId,
            'reference'     => 'PS-' . $productId,
            'name'          => 'deleted',
            'price'         => 0,
        ];

        $this->apiRequest('POST', '/v1/webhook/prestashop/product', $payload);

        PrestaShopLogger::addLog(
            'Peninsula PS8: produit #' . $productId . ' (delete) → API',
            1, null, 'Product', $productId, true
        );
    }

    /* ── Hook : commande validée → Peninsula ─────────── */

    public function hookActionValidateOrder($params)
    {
        $order = $params['order'];

        $items = [];
        foreach ($order->getProducts() as $product) {
            $items[] = [
                'ps_product_id' => (int) $product['product_id'],
                'name'          => $product['product_name'],
                'quantity'      => (int) $product['product_quantity'],
                'unit_price'    => (float) $product['unit_price_tax_incl'],
                'reference'     => $product['product_reference'],
            ];
        }

        // Client PS
        $customer = new \Customer((int) $order->id_customer);
        $address  = new \Address((int) $order->id_address_delivery);

        $payload = [
            'ps_order_id' => (int) $order->id,
            'reference'   => $order->reference,
            'total'       => (float) $order->total_paid_tax_incl,
            'currency'    => \Currency::getCurrencyInstance($order->id_currency)->iso_code,
            'customer'    => [
                'ps_customer_id' => (int) $customer->id,
                'first_name'     => $customer->firstname,
                'last_name'      => $customer->lastname,
                'email'          => $customer->email,
                'phone'          => $address->phone ?: $address->phone_mobile,
                'address'        => [
                    'street'  => $address->address1,
                    'city'    => $address->city,
                    'zip'     => $address->postcode,
                    'country' => \Country::getIsoById($address->id_country),
                ],
            ],
            'items'       => $items,
            'created_at'  => $order->date_add,
        ];

        $this->apiRequest('POST', '/v1/webhook/prestashop/order', $payload);

        PrestaShopLogger::addLog(
            'Peninsula: commande #' . $order->id . ' → API',
            1, null, 'Order', (int) $order->id, true
        );
    }

    /* ── Hook : stock modifié dans PS → log Peninsula ── */

    public function hookActionUpdateQuantity($params)
    {
        $productId = (int) $params['id_product'];
        $newQty    = (int) $params['quantity'];

        $product = new \Product($productId);
        if (!\Validate::isLoadedObject($product)) {
            return;
        }

        $this->apiRequest('POST', '/v1/webhook/prestashop/stock', [
            'ps_product_id' => $productId,
            'reference'     => $product->reference ?: 'PS-' . $productId,
            'quantity'       => $newQty,
        ]);
    }

    public function hookDisplayBackOfficeHeader()
    {
        // Placeholder
    }

    /* ── Full sync : push ALL PS products → API ──────── */

    public function pushAllProductsToApi()
    {
        $result = ['pushed' => 0, 'errors' => []];
        $idLang = (int) Configuration::get('PS_LANG_DEFAULT');

        $sql = new \DbQuery();
        $sql->select('id_product');
        $sql->from('product');
        $sql->orderBy('id_product ASC');
        $rows = \Db::getInstance()->executeS($sql);

        if (!$rows) {
            return $result;
        }

        foreach ($rows as $row) {
            try {
                $product = new \Product((int) $row['id_product'], false, $idLang);
                if (!\Validate::isLoadedObject($product)) {
                    continue;
                }

                // Ignorer les produits sans nom (produits fantômes PS)
                $pName = $product->name[$idLang] ?? $product->name[1] ?? '';
                if (empty(trim($pName))) {
                    continue;
                }

                $payload = $this->buildProductPayload($product, 'update');
                $response = $this->apiRequest('POST', '/v1/webhook/prestashop/product', $payload);

                if ($response['code'] >= 200 && $response['code'] < 300) {
                    $result['pushed']++;
                } else {
                    $result['errors'][] = 'Produit #' . $product->id . ' (' . $product->reference . ') : HTTP ' . $response['code'];
                }
            } catch (\Exception $e) {
                $result['errors'][] = 'Produit #' . $row['id_product'] . ' : ' . $e->getMessage();
            }
        }

        PrestaShopLogger::addLog(
            'Peninsula full sync: ' . $result['pushed'] . ' poussés, ' . count($result['errors']) . ' erreurs.',
            1, null, 'PeninsulaConnector', 0, true
        );

        return $result;
    }
}
